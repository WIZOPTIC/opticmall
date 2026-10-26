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
 *   firebase functions:secrets:set TOSS_SECRET_KEY   (토스페이먼츠 시크릿 키, 결제 승인용)
 *
 * 배포:
 *   cd functions && npm install
 *   firebase deploy --only functions
 */

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
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
const TOSS_SECRET_KEY = defineSecret("TOSS_SECRET_KEY"); // 토스페이먼츠 시크릿 키 (서버에만 보관)

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

/**
 * 이메일(아이디) 중복 확인
 * 입력: { email }
 * 반환: { exists: boolean }
 *
 * 주의: 클라이언트에서 Firebase Auth의 fetchSignInMethodsForEmail()을 직접 쓰면
 *       "이메일 열거 보호(Email Enumeration Protection)" 설정 때문에 가입된 이메일이어도
 *       항상 빈 배열을 반환해서 "사용 가능합니다"로 잘못 뜬다.
 *       Admin SDK(getUserByEmail)는 이 보호의 영향을 받지 않으므로 서버(Cloud Function)에서 확인한다.
 */
exports.checkEmailExists = onCall(async (request) => {
  const email = String(request.data?.email || "").trim().toLowerCase();

  if (!email || !email.includes("@")) {
    throw new HttpsError("invalid-argument", "올바른 이메일을 입력해주세요.");
  }

  try {
    await admin.auth().getUserByEmail(email);
    return { exists: true };
  } catch (e) {
    if (e.code === "auth/user-not-found") {
      return { exists: false };
    }
    throw new HttpsError("internal", "이메일 확인 중 오류가 발생했습니다.");
  }
});

/* ============================================================================
 * 결제 승인 (confirmPayment)
 * ----------------------------------------------------------------------------
 * 흐름: 결제 성공 페이지 -> 이 함수 호출 -> (1) 서버에서 가격/배송비/쿠폰/적립금 재검증
 *       -> (2) 재고 확인 -> (3) 토스페이먼츠 승인 요청 -> (4) 주문 확정(재고 차감, 적립금/쿠폰/구매등급 처리,
 *       장바구니 정리)을 한 번에 처리. 검증에 실패하면 토스에 승인 요청 자체를 보내지 않으므로 돈이 빠지지 않음.
 * 입력: { orderId, paymentKey, amount }
 * 반환: { ok: true, already?: true }
 * ============================================================================ */

const FREE_SHIPPING_THRESHOLD = 100000; // 10만원 이상 무료배송
const BASE_SHIPPING_FEE = 3500;
const JEJU_EXTRA_FEE = 3000; // 제주/도서산간 추가비
const REMOTE_KEYWORDS = ["제주", "울릉", "독도", "가거도", "거문도", "고흥", "신안", "완도", "진도", "홍도"];

const PURCHASE_LEVELS = [
  { level: 1, name: "화이트", min: 0 },
  { level: 2, name: "실버", min: 1000000 },
  { level: 3, name: "골드", min: 3000000 },
  { level: 4, name: "플래티넘", min: 5000000 },
  { level: 5, name: "옵틱 마스터", min: 10000000 },
];
function calcPurchaseLevel(total) {
  let r = PURCHASE_LEVELS[0];
  for (const lv of PURCHASE_LEVELS) if (total >= lv.min) r = lv;
  return r;
}

function isRemoteAddress(addr) {
  return REMOTE_KEYWORDS.some((kw) => String(addr || "").includes(kw));
}

function computeCouponDiscount(coupon, productAmount) {
  if (!coupon) return 0;
  if (productAmount < (coupon.minOrderAmount || 0)) return 0;
  if (coupon.type === "fixed") {
    return Math.min(Number(coupon.value) || 0, productAmount);
  } else if (coupon.type === "percent") {
    let d = Math.floor(productAmount * ((Number(coupon.value) || 0) / 100));
    if (coupon.maxDiscountAmount != null) d = Math.min(d, Number(coupon.maxDiscountAmount));
    return Math.min(d, productAmount);
  }
  return 0;
}

/** 진행 중인 이벤트/타임세일 할인율 지도 (productId -> 최고 할인율). 주문서(order.html)와 동일한 기준 */
async function loadDiscountMap() {
  const map = {};
  const today = new Date().toISOString().slice(0, 10);
  const promoSnap = await db.collection("promotions").where("status", "==", "approved").get();
  promoSnap.forEach((d) => {
    const promo = d.data();
    if (promo.startDate > today || promo.endDate < today) return;
    const r = Number(promo.discountRate) || 0;
    (promo.targetProductIds || []).forEach((pid) => {
      if (r > (map[pid] || 0)) map[pid] = r;
    });
  });
  try {
    const tsSet = await db.collection("settings").doc("timesale").get();
    const endRaw = tsSet.exists ? tsSet.data().endAt : null;
    const endDate = endRaw && endRaw.toDate ? endRaw.toDate() : null;
    if (endDate && endDate > new Date()) {
      const tsSnap = await db.collection("timesaleItems").where("status", "==", "approved").get();
      tsSnap.forEach((d) => {
        const t = d.data();
        const r = Number(t.discountRate) || 0;
        if (t.productId && r > (map[t.productId] || 0)) map[t.productId] = r;
      });
    }
  } catch (e) {
    console.error("타임세일 조회 실패:", e);
  }
  return map;
}

/** 상품 1개의 실제 판매 단가 (주문서와 동일한 계산) */
function computeUnitPrice(product, colorIdx, eventRate) {
  const colorData = Array.isArray(product.colors) ? product.colors[colorIdx] : null;
  const hasColorPrice = colorData && colorData.price != null && colorData.price !== "";
  const basePrice = hasColorPrice ? Number(colorData.price) : Number(product.price || 0);
  const productRate = Number(product.discountRate) || 0;
  const finalRate = Math.max(eventRate || 0, productRate);
  if (finalRate > 0) {
    if (!hasColorPrice && productRate > 0 && productRate === finalRate && Number(product.salePrice) > 0) {
      return Number(product.salePrice);
    }
    return Math.round(basePrice * (1 - finalRate / 100));
  }
  return basePrice;
}

async function tossRequest(path, secretKey, body) {
  const res = await fetch("https://api.tosspayments.com" + path, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(secretKey + ":").toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  return { ok: res.ok, status: res.status, data };
}

exports.confirmPayment = onCall(
  { secrets: [TOSS_SECRET_KEY], timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
    }
    const uid = request.auth.uid;
    const orderId = String(request.data?.orderId || "").trim();
    const paymentKey = String(request.data?.paymentKey || "").trim();
    const amount = Number(request.data?.amount);

    if (!orderId || !paymentKey || !Number.isFinite(amount)) {
      throw new HttpsError("invalid-argument", "결제 정보가 올바르지 않습니다.");
    }

    const orderRef = db.collection("orders").doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "주문 내역을 찾을 수 없습니다.");
    }
    const order = orderSnap.data();
    if (order.userId !== uid) {
      throw new HttpsError("permission-denied", "본인의 주문이 아닙니다.");
    }

    // 이미 처리된 주문(새로고침 등) - 중복 처리하지 않고 성공으로 응답
    if (order.status !== "payment_pending") {
      if (order.paymentKey === paymentKey) {
        return { ok: true, already: true };
      }
      throw new HttpsError("failed-precondition", "이미 처리된 주문입니다.");
    }

    // 동시 호출 방지 (60초 잠금)
    const lockOk = await db.runTransaction(async (tx) => {
      const snap = await tx.get(orderRef);
      const d = snap.data();
      if (d.status !== "payment_pending") return false;
      const lockMs = d.confirmLockAt?.toMillis?.() || 0;
      if (Date.now() - lockMs < 60 * 1000) return false;
      tx.update(orderRef, { confirmLockAt: admin.firestore.FieldValue.serverTimestamp() });
      return true;
    });
    if (!lockOk) {
      throw new HttpsError("aborted", "결제 처리 중입니다. 잠시 후 다시 확인해주세요.");
    }

    // 검증 단계에서 실패하면 잠금을 풀어서 바로 다시 시도할 수 있게 함
    const userRef = db.collection("users").doc(uid);
    let couponRef = null;
    let needByProduct = {};
    let pointsUsed = 0;
    let items = [];
    try {
      // 회원 승인 상태 확인
      const userSnap = await userRef.get();
      const user = userSnap.exists ? userSnap.data() : {};
      if ((Number(user.member_level) || 0) < 2) {
        throw new HttpsError("permission-denied", "안경사 인증 승인 후 주문이 가능합니다.");
      }

      // ---------- (1) 서버 재검증: 상품 가격 / 배송비 / 쿠폰 / 적립금 ----------
      items = Array.isArray(order.items) ? order.items : [];
      if (items.length === 0) {
        throw new HttpsError("failed-precondition", "주문 상품 정보가 없습니다.");
      }

      const productIds = [...new Set(items.map((it) => it.productId).filter(Boolean))];
      const productSnaps = await Promise.all(productIds.map((pid) => db.collection("products").doc(pid).get()));
      const products = {};
      productSnaps.forEach((s) => {
        if (s.exists) products[s.id] = s.data();
      });

      const discountMap = await loadDiscountMap();

      let productAmount = 0;
      needByProduct = {}; // productId -> { colors: {idx: qty}, plain: qty }
      for (const it of items) {
        const p = products[it.productId];
        if (!p) {
          throw new HttpsError("failed-precondition", `판매가 종료되었거나 삭제된 상품이 있습니다. (${it.productName || it.productId})`);
        }
        if (p.status && p.status !== "approved") {
          throw new HttpsError("failed-precondition", `현재 판매 중이 아닌 상품이 있습니다. (${it.productName || ""})`);
        }
        const qty = Number(it.qty);
        if (!Number.isInteger(qty) || qty < 1) {
          throw new HttpsError("invalid-argument", "주문 수량이 올바르지 않습니다.");
        }
        const colorIdx = Number(it.selectedColorIdx) || 0;
        const unit = computeUnitPrice(p, colorIdx, discountMap[it.productId] || 0);
        if (unit !== Number(it.unitPrice)) {
          throw new HttpsError(
            "failed-precondition",
            `상품 가격이 변경되었습니다. 주문서를 다시 열어 확인해주세요. (${it.productName || ""})`
          );
        }
        productAmount += unit * qty;

        const need = (needByProduct[it.productId] = needByProduct[it.productId] || { colors: {}, plain: 0 });
        if (Array.isArray(p.colors) && p.colors.length > colorIdx) {
          need.colors[colorIdx] = (need.colors[colorIdx] || 0) + qty;
        } else {
          need.plain += qty;
        }
      }
      if (productAmount !== Number(order.productAmount)) {
        throw new HttpsError("failed-precondition", "주문 금액이 올바르지 않습니다. 주문서를 다시 열어 확인해주세요.");
      }

      const shippingFee =
        (productAmount >= FREE_SHIPPING_THRESHOLD ? 0 : BASE_SHIPPING_FEE) +
        (isRemoteAddress(order.receiver?.addr1) ? JEJU_EXTRA_FEE : 0);
      if (shippingFee !== Number(order.shippingFee)) {
        throw new HttpsError("failed-precondition", "배송비가 올바르지 않습니다. 주문서를 다시 열어 확인해주세요.");
      }

      // 쿠폰
      let couponDiscount = 0;
      if (order.couponId) {
        couponRef = userRef.collection("coupons").doc(order.couponId);
        const cSnap = await couponRef.get();
        if (!cSnap.exists) throw new HttpsError("failed-precondition", "사용할 수 없는 쿠폰입니다.");
        const c = cSnap.data();
        const exp = c.expiresAt?.toDate ? c.expiresAt.toDate() : c.expiresAt ? new Date(c.expiresAt) : null;
        if (c.used || (exp && exp < new Date())) {
          throw new HttpsError("failed-precondition", "이미 사용했거나 기간이 지난 쿠폰입니다.");
        }
        couponDiscount = computeCouponDiscount(c, productAmount);
      }
      if (couponDiscount !== (Number(order.couponDiscount) || 0)) {
        throw new HttpsError("failed-precondition", "쿠폰 할인 금액이 올바르지 않습니다.");
      }

      // 적립금
      pointsUsed = Number(order.pointsUsed) || 0;
      const balance = Number(user.pointsBalance) || 0;
      if (!Number.isInteger(pointsUsed) || pointsUsed < 0 || pointsUsed > balance) {
        throw new HttpsError("failed-precondition", "적립금 사용 금액이 올바르지 않습니다.");
      }
      if (pointsUsed > Math.max(0, productAmount + shippingFee - couponDiscount)) {
        throw new HttpsError("failed-precondition", "적립금 사용 금액이 결제 금액보다 큽니다.");
      }

      const expectedTotal = Math.max(0, productAmount + shippingFee - couponDiscount - pointsUsed);
      if (expectedTotal !== Number(order.totalAmount) || expectedTotal !== amount) {
        throw new HttpsError("failed-precondition", "결제 금액이 주문 금액과 일치하지 않습니다. 고객센터로 문의해주세요.");
      }

      // ---------- (2) 재고 사전 확인 ----------
      for (const pid of Object.keys(needByProduct)) {
        const p = products[pid];
        const need = needByProduct[pid];
        for (const idx of Object.keys(need.colors)) {
          const stock = Number(p.colors[idx]?.stock || 0);
          if (stock < need.colors[idx]) {
            throw new HttpsError(
              "failed-precondition",
              `재고가 부족합니다. (${p.modelName || pid} ${p.colors[idx]?.colorName || ""} / 남은 재고 ${stock}개)`
            );
          }
        }
        if (need.plain > 0 && Number(p.stock || 0) < need.plain) {
          throw new HttpsError("failed-precondition", `재고가 부족합니다. (${p.modelName || pid} / 남은 재고 ${Number(p.stock || 0)}개)`);
        }
      }
    } catch (e) {
      await orderRef.update({ confirmLockAt: admin.firestore.FieldValue.delete() });
      throw e;
    }

    // ---------- (3) 토스페이먼츠 결제 승인 ----------
    const secret = TOSS_SECRET_KEY.value();
    const confirmRes = await tossRequest("/v1/payments/confirm", secret, { paymentKey, orderId, amount });

    if (!confirmRes.ok) {
      // 다른 요청이 먼저 승인한 경우 등: 주문이 이미 확정됐는지 한 번 더 확인
      const again = (await orderRef.get()).data();
      if (again.status !== "payment_pending" && again.paymentKey === paymentKey) {
        return { ok: true, already: true };
      }
      await orderRef.update({
        confirmLockAt: admin.firestore.FieldValue.delete(),
        lastPaymentError: {
          code: confirmRes.data.code || "",
          message: confirmRes.data.message || "",
          at: admin.firestore.FieldValue.serverTimestamp(),
        },
      });
      throw new HttpsError("failed-precondition", confirmRes.data.message || "결제 승인에 실패했습니다.");
    }
    const payment = confirmRes.data;

    // ---------- (4) 주문 확정 (한 번에 처리: 모두 성공하거나 모두 취소) ----------
    try {
      await db.runTransaction(async (tx) => {
        const oSnap = await tx.get(orderRef);
        const o = oSnap.data();
        if (o.status !== "payment_pending") throw new Error("ALREADY_PROCESSED");

        const pRefs = Object.keys(needByProduct).map((pid) => db.collection("products").doc(pid));
        const pSnaps = await Promise.all(pRefs.map((r) => tx.get(r)));
        const uSnap = await tx.get(userRef);
        const cSnap = couponRef ? await tx.get(couponRef) : null;

        const uData = uSnap.data() || {};
        const curBalance = Number(uData.pointsBalance) || 0;
        if (pointsUsed > curBalance) throw new Error("POINTS_INSUFFICIENT");
        if (cSnap && (!cSnap.exists || cSnap.data().used)) throw new Error("COUPON_USED");

        // 재고 차감
        pSnaps.forEach((pSnap, i) => {
          const pid = Object.keys(needByProduct)[i];
          const pData = pSnap.data();
          const need = needByProduct[pid];
          const payload = {};
          if (Object.keys(need.colors).length > 0) {
            const colors = pData.colors.map((c) => ({ ...c }));
            for (const idx of Object.keys(need.colors)) {
              const left = Number(colors[idx].stock || 0) - need.colors[idx];
              if (left < 0) throw new Error("STOCK_INSUFFICIENT");
              colors[idx].stock = left;
            }
            payload.colors = colors;
          }
          if (need.plain > 0) {
            const left = Number(pData.stock || 0) - need.plain;
            if (left < 0) throw new Error("STOCK_INSUFFICIENT");
            payload.stock = left;
          }
          tx.update(pRefs[i], payload);
        });

        // 적립금 차감 + 내역
        if (pointsUsed > 0) {
          tx.set(userRef.collection("pointsLedger").doc(), {
            type: "use",
            amount: -pointsUsed,
            orderId,
            note: "주문 결제 시 적립금 사용",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }

        // 쿠폰 사용 처리
        if (couponRef) {
          tx.update(couponRef, {
            used: true,
            usedAt: admin.firestore.FieldValue.serverTimestamp(),
            usedOrderId: orderId,
          });
        }

        // 구매 누적 금액 / 등급 (결제금액 기준)
        const newTotal = (Number(uData.total_purchase_amount) || 0) + amount;
        const lv = calcPurchaseLevel(newTotal);
        tx.update(userRef, {
          pointsBalance: curBalance - pointsUsed,
          total_purchase_amount: newTotal,
          purchase_level: lv.level,
          purchase_level_name: lv.name,
        });

        // 주문 상태: 결제완료 (브랜드별 배송묶음도 함께)
        const shipments = Array.isArray(o.shipments) ? o.shipments.map((s) => ({ ...s, status: "paid" })) : [];
        const orderUpdate = {
          status: "paid",
          paymentKey,
          paidAmount: amount,
          paymentMethod: payment.method || "",
          paymentApprovedAt: payment.approvedAt || "",
          receiptUrl: payment.receipt?.url || "",
          paymentPassedAt: admin.firestore.FieldValue.serverTimestamp(),
          couponConsumed: !!couponRef,
          confirmLockAt: admin.firestore.FieldValue.delete(),
        };
        if (shipments.length > 0) orderUpdate.shipments = shipments;
        tx.update(orderRef, orderUpdate);
      });
    } catch (e) {
      // 승인은 됐지만 주문 확정에 실패 -> 결제 자동 취소(환불)
      console.error("주문 확정 실패, 결제 취소 진행:", orderId, e.message);
      if (e.message === "ALREADY_PROCESSED") {
        return { ok: true, already: true };
      }
      const cancelRes = await tossRequest(`/v1/payments/${encodeURIComponent(paymentKey)}/cancel`, secret, {
        cancelReason: "주문 처리 중 오류로 자동 취소",
      });
      await orderRef.update({
        status: "payment_failed",
        confirmLockAt: admin.firestore.FieldValue.delete(),
        lastPaymentError: {
          code: e.message,
          message: cancelRes.ok ? "자동 환불 완료" : "자동 환불 실패 - 토스 대시보드에서 직접 취소 필요",
          at: admin.firestore.FieldValue.serverTimestamp(),
        },
      });
      const msg =
        e.message === "STOCK_INSUFFICIENT"
          ? "결제 직전에 재고가 소진되어 결제가 취소되었습니다."
          : "주문 처리 중 문제가 발생하여 결제가 취소되었습니다.";
      throw new HttpsError("aborted", msg);
    }

    // 장바구니 정리 (주문한 상품) - 실패해도 주문에는 영향 없음
    try {
      const cartSnap = await db.collection("carts").doc(uid).collection("items").get();
      const batch = db.batch();
      const ordered = new Set(items.map((i) => i.productId));
      cartSnap.forEach((d) => {
        if (ordered.has(d.data().productId)) batch.delete(d.ref);
      });
      await batch.commit();
    } catch (e) {
      console.error("장바구니 정리 실패:", e);
    }

    return { ok: true };
  }
);

/**
 * 회원 탈퇴 공통 처리 (본인 탈퇴 / 관리자 강제 탈퇴 모두 사용)
 *  - 진행 중인 주문(결제완료~배송중, 취소/반품 진행 중)이 있으면 막음
 *  - 삭제: 회원정보, 배송지, 적립금내역, 쿠폰, 장바구니, 관심상품, 재입고알림, 사업자등록증 파일, 로그인 계정
 *  - 보관: 주문/결제 기록은 전자상거래법에 따라 보관 (주문에 '탈퇴 회원' 표시만 추가)
 *  - 후기/문의는 남기되 작성자 이름만 '탈퇴한 회원'으로 변경
 *  - 같은 사업자번호로 재가입해도 가입 쿠폰을 또 받지 못하도록 사업자번호만 withdrawnBiz에 남김
 */
async function purgeMember(uid, userData, actor) {
  if (userData.role !== "optician") {
    throw new HttpsError("failed-precondition", "브랜드사·관리자 계정은 이 방법으로 탈퇴시킬 수 없습니다.");
  }
  const ACTIVE = [
    "payment_window_passed", "paid", "preparing", "shipping",
    "cancel_requested", "return_requested",
  ];
  const ordersSnap = await db.collection("orders").where("userId", "==", uid).get();
  if (ordersSnap.docs.some((d) => ACTIVE.includes(d.data().status))) {
    throw new HttpsError(
      "failed-precondition",
      "진행 중인 주문이 있어 탈퇴 처리할 수 없습니다. 배송이 완료되거나 취소가 끝난 뒤 다시 시도해주세요."
    );
  }

  // 주문 기록은 보관하되 탈퇴 표시
  let batch = db.batch();
  let n = 0;
  for (const d of ordersSnap.docs) {
    batch.update(d.ref, {
      userWithdrawn: true,
      withdrawnAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
  }
  await batch.commit();

  // 후기/문의 작성자 이름 비식별 처리
  for (const col of ["reviews", "inquiries"]) {
    const snap = await db.collection(col).where("userId", "==", uid).get();
    for (const d of snap.docs) {
      const upd = {};
      if ("userName" in d.data()) upd.userName = "탈퇴한 회원";
      if ("userEmail" in d.data()) upd.userEmail = "";
      if (Object.keys(upd).length) await d.ref.update(upd);
    }
  }

  // 같은 사업자번호 재가입 시 가입 쿠폰 중복 지급 방지용 기록 (개인정보 없음)
  const biz = String(userData.bizNoNormalized || "").trim();
  if (biz) {
    await db.collection("withdrawnBiz").doc(biz).set({
      withdrawnAt: admin.firestore.FieldValue.serverTimestamp(),
      by: actor,
    }, { merge: true });
  }

  // 개인정보 삭제
  for (const c of ["carts", "wishlists", "restockAlerts"]) {
    await db.recursiveDelete(db.collection(c).doc(uid));
  }
  await db.collection("findIdCodes").doc(uid).delete().catch(() => {});
  try {
    await admin.storage().bucket("opticmall.firebasestorage.app")
      .deleteFiles({ prefix: `business_docs/${uid}/`, force: true });
  } catch (e) {
    console.error("사업자등록증 파일 삭제 실패:", e);
  }
  await db.recursiveDelete(db.collection("users").doc(uid)); // 회원정보 + 배송지/적립금내역/쿠폰

  // 로그인 계정 삭제 (마지막)
  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    if (e.code !== "auth/user-not-found") throw e;
  }
}

/** 회원 본인 탈퇴 */
exports.withdrawAccount = onCall({ timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) throw new HttpsError("not-found", "회원 정보를 찾을 수 없습니다.");
  await purgeMember(uid, snap.data(), uid);
  return { ok: true };
});

/** 관리자(마스터/서브마스터)가 안경원 회원을 강제 탈퇴 */
exports.adminWithdrawMember = onCall({ timeoutSeconds: 120 }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const meSnap = await db.collection("users").doc(request.auth.uid).get();
  const myRole = meSnap.exists ? meSnap.data().role : null;
  if (myRole !== "master" && myRole !== "submaster") {
    throw new HttpsError("permission-denied", "관리자만 사용할 수 있습니다.");
  }
  const targetUid = String(request.data?.targetUid || "").trim();
  if (!targetUid || targetUid === request.auth.uid) {
    throw new HttpsError("invalid-argument", "대상 회원이 올바르지 않습니다.");
  }
  const tSnap = await db.collection("users").doc(targetUid).get();
  if (!tSnap.exists) throw new HttpsError("not-found", "회원 정보를 찾을 수 없습니다.");
  await purgeMember(targetUid, tSnap.data(), "admin:" + request.auth.uid);
  return { ok: true };
});

/**
 * 가입 쿠폰 지급 (가입 직후 본인이 호출, 서버가 대신 지급)
 *  - 같은 사업자등록번호로 이미 가입한 다른 계정이 있거나, 탈퇴한 기록이 있으면 지급하지 않음
 *  - 이미 지급된 계정은 다시 지급하지 않음
 */
exports.claimSignupCoupons = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "로그인이 필요합니다.");
  }
  const uid = request.auth.uid;
  const userRef = db.collection("users").doc(uid);
  const snap = await userRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "회원 정보를 찾을 수 없습니다.");
  const u = snap.data();
  if (u.role !== "optician") return { granted: false, reason: "not-optician" };

  const fixedRef = userRef.collection("coupons").doc("signup_fixed");
  const firstRef = userRef.collection("coupons").doc("signup_first10");
  const [fx, fr] = await Promise.all([fixedRef.get(), firstRef.get()]);
  if (fx.exists || fr.exists) return { granted: false, reason: "already" };

  const biz = String(u.bizNoNormalized || "").trim();
  if (biz) {
    const [dup, wd] = await Promise.all([
      db.collection("users").where("bizNoNormalized", "==", biz).get(),
      db.collection("withdrawnBiz").doc(biz).get(),
    ]);
    const otherExists = dup.docs.some((d) => d.id !== uid);
    if (otherExists || wd.exists) return { granted: false, reason: "duplicate-biz" };
  }

  const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const base = {
    used: false, usedAt: null, usedOrderId: null,
    source: "signup_bonus",
    issuedAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt,
  };
  const batch = db.batch();
  batch.set(fixedRef, {
    ...base, name: "회원가입 쿠폰", type: "fixed", value: 25000,
    minOrderAmount: 300000, maxDiscountAmount: null, firstPurchaseOnly: false,
  });
  batch.set(firstRef, {
    ...base, name: "첫 구매 10% 할인 쿠폰", type: "percent", value: 10,
    minOrderAmount: 200000, maxDiscountAmount: 20000, firstPurchaseOnly: true,
  });
  await batch.commit();
  return { granted: true };
});

/**
 * 택배 배송조회 (스윗트래커 API 중계)
 * - 마이페이지 배송조회 창에서 호출: GET ?t_code=택배사코드&t_invoice=운송장번호
 * - API 키는 이 폴더의 .env 파일(SWEETTRACKER_KEY)에서 읽으며, 사이트 코드에는 노출되지 않음
 */
exports.getTrackingInfo = onRequest({ cors: true, timeoutSeconds: 30 }, async (req, res) => {
  try {
    const code = String(req.query.t_code || "").trim();
    const invoice = String(req.query.t_invoice || "").replace(/[^0-9A-Za-z]/g, "");
    if (!/^[0-9]{1,3}$/.test(code) || invoice.length < 5 || invoice.length > 30) {
      res.status(400).json({ result: "N", msg: "택배사 또는 운송장번호가 올바르지 않습니다." });
      return;
    }
    const key = process.env.SWEETTRACKER_KEY;
    if (!key) {
      console.error("SWEETTRACKER_KEY 가 설정되지 않았습니다.");
      res.status(500).json({ result: "N", msg: "배송조회 설정 오류" });
      return;
    }
    // 스윗트래커는 2026-10-30 14시부터 GET 호출을 종료하고 POST만 지원 → POST(form) 우선, 실패 시에만 GET 재시도
    const endpoint = "https://info.sweettracker.co.kr/api/v1/trackingInfo";
    const params = new URLSearchParams({ t_key: key, t_code: code, t_invoice: invoice });
    let data = null;
    try {
      const rp = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const txt = await rp.text();
      try { data = JSON.parse(txt); } catch (e) { data = null; }
      if (!rp.ok && !data) console.error("스윗트래커 POST 응답 이상:", rp.status);
    } catch (e) {
      console.error("스윗트래커 POST 호출 실패:", e);
    }
    if (!data) {
      const rg = await fetch(endpoint + "?" + params.toString());
      data = await rg.json();
    }
    res.set("Cache-Control", "no-store");
    res.status(200).json(data);
  } catch (e) {
    console.error("getTrackingInfo 오류:", e);
    res.status(500).json({ result: "N", msg: "배송조회 중 오류가 발생했습니다." });
  }
});

/**
 * 실시간 베스트 상품 집계 (매일 새벽 4시 자동 실행)
 * 최근 60일 주문 중 결제 완료 이후 상태(paid / preparing / shipping / delivered)의
 * 상품별 판매 수량을 합산해 settings/bestRank 문서에 상위 30개를 저장합니다.
 * 메인/베스트 페이지는 이 문서 하나만 읽으므로 방문자가 늘어도 DB 읽기 비용이 거의 늘지 않습니다.
 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const BEST_WINDOW_DAYS = 60;
const BEST_STATUSES = new Set(["paid", "preparing", "shipping", "delivered"]);

exports.updateBestRank = onSchedule(
  { schedule: "every day 04:00", timeZone: "Asia/Seoul", timeoutSeconds: 120, memory: "256MiB" },
  async () => {
    const since = admin.firestore.Timestamp.fromMillis(Date.now() - BEST_WINDOW_DAYS * 24 * 3600 * 1000);
    const snap = await db.collection("orders").where("createdAt", ">=", since).get();
    const qtyMap = new Map();
    snap.forEach((doc) => {
      const o = doc.data();
      if (!BEST_STATUSES.has(o.status)) return;
      (Array.isArray(o.items) ? o.items : []).forEach((it) => {
        const pid = it && it.productId;
        if (!pid) return;
        const q = Number(it.qty || it.quantity || 1) || 1;
        qtyMap.set(pid, (qtyMap.get(pid) || 0) + q);
      });
    });
    const items = [...qtyMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([productId, qty]) => ({ productId, qty }));
    await db.collection("settings").doc("bestRank").set({
      items,
      windowDays: BEST_WINDOW_DAYS,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`updateBestRank: ${snap.size}건 집계, 상위 ${items.length}개 저장`);
  }
);
