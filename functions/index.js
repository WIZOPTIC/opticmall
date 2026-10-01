/**
 * OPTICMALL 아이디 찾기 (Find ID) Cloud Functions
 * -------------------------------------------------
 * 흐름:
 *  1) requestFindIdCode  : 이름 + 전화번호로 회원 조회 → 일치하면 등록된 이메일로 인증번호(6자리) 발송
 *  2) verifyFindIdCode   : 이름 + 전화번호 + 인증번호 확인 → 맞으면 이메일(아이디) 반환
 *
 * 비용: Cloud Functions 무료 할당량(월 200만 건) 안에서 충분히 처리되고,
 *       이메일 발송은 Gmail SMTP(앱 비밀번호)를 사용하므로 별도 비용이 들지 않습니다.
 *       (Gmail 일일 발송 한도 약 500통 - 아이디 찾기 용도로는 절대 초과하지 않음)
 *
 * 배포 전 꼭 설정해야 하는 것 (최초 1회):
 *   firebase functions:secrets:set GMAIL_USER
 *   firebase functions:secrets:set GMAIL_PASS   (Gmail "앱 비밀번호" 16자리, 계정 비밀번호 아님!)
 *
 * 배포:
 *   cd functions && npm install
 *   firebase deploy --only functions
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// 서울 리전으로 배포 (한국 사용자 기준 응답속도 최적화)
setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 });

const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_PASS = defineSecret("GMAIL_PASS");

const CODE_TTL_MS = 5 * 60 * 1000; // 인증번호 유효시간: 5분
const MAX_ATTEMPTS = 5; // 인증번호 오입력 허용 횟수
const RESEND_COOLDOWN_MS = 60 * 1000; // 재발송 최소 간격: 60초

/** 전화번호 비교용 정규화: 숫자만 남김 (010-1234-5678 → 01012345678) */
function normalizePhone(p) {
  return String(p || "").replace(/[^0-9]/g, "");
}

/** 6자리 숫자 인증번호 생성 */
function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/** 이름 + 전화번호로 users 컬렉션에서 일치하는 회원 1명 찾기 (없으면 null) */
async function findMatchingUser(name, phoneNormalized) {
  const snap = await db.collection("users").where("name", "==", name).get();
  let matched = null;
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    if (normalizePhone(data.phone) === phoneNormalized) {
      matched = { id: docSnap.id, ...data };
    }
  });
  return matched;
}

let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: GMAIL_USER.value(),
      pass: GMAIL_PASS.value(),
    },
  });
  return cachedTransporter;
}

/**
 * 1단계: 인증번호 요청
 * 입력: { name, phone }
 * 반환: { ok: true }  (회원이 없어도 동일하게 응답 — 가입 여부가 외부에 노출되지 않도록)
 */
exports.requestFindIdCode = onCall(
  { secrets: [GMAIL_USER, GMAIL_PASS] },
  async (request) => {
    const name = String(request.data?.name || "").trim();
    const phoneNormalized = normalizePhone(request.data?.phone);

    if (!name || phoneNormalized.length < 9) {
      throw new HttpsError("invalid-argument", "이름과 전화번호를 정확히 입력해주세요.");
    }

    const matched = await findMatchingUser(name, phoneNormalized);

    // 일치하는 회원이 없어도 "요청 완료"로만 응답 (회원 존재 여부를 알려주지 않기 위함)
    if (!matched) {
      return { ok: true };
    }

    const codeDocRef = db.collection("findIdCodes").doc(matched.id);
    const existing = await codeDocRef.get();

    // 너무 잦은 재발송 방지
    if (existing.exists) {
      const createdAtMs = existing.data().createdAt?.toMillis?.() || 0;
      if (Date.now() - createdAtMs < RESEND_COOLDOWN_MS) {
        throw new HttpsError(
          "resource-exhausted",
          "잠시 후 다시 시도해주세요. (재발송은 60초 간격으로 가능합니다)"
        );
      }
    }

    const code = generateCode();

    await codeDocRef.set({
      codeHash: hashCode(code),
      attempts: 0,
      name,
      phoneNormalized,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + CODE_TTL_MS),
    });

    const transporter = getTransporter();
    await transporter.sendMail({
      from: `"OPTICMALL" <${GMAIL_USER.value()}>`,
      to: matched.email,
      subject: "[OPTICMALL] 아이디 찾기 인증번호",
      html: `
        <div style="font-family:'Apple SD Gothic Neo',sans-serif;max-width:420px;margin:0 auto;padding:32px 28px;border:1px solid #eee;border-radius:8px;">
          <h2 style="margin:0 0 18px;font-size:17px;color:#111;">OPTICMALL 아이디 찾기</h2>
          <p style="font-size:13px;color:#666;line-height:1.6;margin:0 0 20px;">
            아래 인증번호를 아이디 찾기 화면에 입력해주세요.<br>
            인증번호는 <b>5분간</b> 유효합니다.
          </p>
          <div style="background:#f7f4ee;border-radius:6px;padding:18px;text-align:center;margin-bottom:20px;">
            <span style="font-size:28px;font-weight:700;letter-spacing:8px;color:#111;">${code}</span>
          </div>
          <p style="font-size:11.5px;color:#aaa;line-height:1.6;margin:0;">
            본인이 요청하지 않았다면 이 메일을 무시해주세요.
          </p>
        </div>
      `,
    });

    return { ok: true };
  }
);

/**
 * 2단계: 인증번호 확인
 * 입력: { name, phone, code }
 * 반환: { email }  — 성공 시 등록된 이메일(아이디) 반환
 */
exports.verifyFindIdCode = onCall(async (request) => {
  const name = String(request.data?.name || "").trim();
  const phoneNormalized = normalizePhone(request.data?.phone);
  const code = String(request.data?.code || "").trim();

  if (!name || phoneNormalized.length < 9 || !code) {
    throw new HttpsError("invalid-argument", "입력값을 확인해주세요.");
  }

  const matched = await findMatchingUser(name, phoneNormalized);
  if (!matched) {
    throw new HttpsError("not-found", "일치하는 회원 정보가 없습니다.");
  }

  const codeDocRef = db.collection("findIdCodes").doc(matched.id);
  const codeDoc = await codeDocRef.get();

  if (!codeDoc.exists) {
    throw new HttpsError("failed-precondition", "먼저 인증번호를 요청해주세요.");
  }

  const codeData = codeDoc.data();

  if (codeData.attempts >= MAX_ATTEMPTS) {
    await codeDocRef.delete();
    throw new HttpsError(
      "resource-exhausted",
      "인증 시도 횟수를 초과했습니다. 인증번호를 다시 요청해주세요."
    );
  }

  if (Date.now() > codeData.expiresAt.toMillis()) {
    await codeDocRef.delete();
    throw new HttpsError("deadline-exceeded", "인증번호가 만료되었습니다. 다시 요청해주세요.");
  }

  if (hashCode(code) !== codeData.codeHash) {
    await codeDocRef.update({ attempts: admin.firestore.FieldValue.increment(1) });
    throw new HttpsError("permission-denied", "인증번호가 일치하지 않습니다.");
  }

  // 인증 성공 - 코드는 1회용이므로 즉시 삭제
  await codeDocRef.delete();

  return { email: matched.email };
});
