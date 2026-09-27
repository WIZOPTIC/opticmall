/**
 * OPTICMALL - 배송조회 프록시 함수
 *
 * 프론트엔드(mypage.html)가 스마트택배 API를 직접 호출하면 API 키가
 * 브라우저 소스코드/깃허브에 그대로 노출되므로, 이 함수가 대신 호출해주는 중계 역할을 합니다.
 * API 키는 .env 파일에만 저장되고 절대 깃허브에 올라가지 않습니다.
 *
 * 호출 예시 (프론트엔드에서):
 *   https://asia-northeast3-opticmall.cloudfunctions.net/getTrackingInfo?t_code=04&t_invoice=698809846835
 *
 * [2026-09-27] 스마트택배 API의 GET 방식 지원 종료(2026-10-30) 공지에 따라
 * POST + JSON body 방식으로 전환. (공식 문서: https://info.sweettracker.co.kr/apidoc)
 */

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

const SWEETTRACKER_KEY = process.env.SWEETTRACKER_KEY;

exports.getTrackingInfo = onRequest(
  { region: "asia-northeast3", cors: true },
  async (req, res) => {
    const courierCode = req.query.t_code;
    const invoiceNo = req.query.t_invoice;

    if (!courierCode || !invoiceNo) {
      res.status(400).json({ error: "t_code(택배사코드)와 t_invoice(운송장번호)가 필요합니다." });
      return;
    }

    if (!SWEETTRACKER_KEY) {
      logger.error("SWEETTRACKER_KEY가 설정되지 않았습니다. functions/.env 파일을 확인하세요.");
      res.status(500).json({ error: "서버에 API 키가 설정되지 않았습니다." });
      return;
    }

    try {
      const response = await fetch("https://info.sweettracker.co.kr/api/v1/trackingInfo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          t_key: SWEETTRACKER_KEY,
          t_code: courierCode,
          t_invoice: invoiceNo,
        }),
      });
      const data = await response.json();

      res.status(200).json(data);
    } catch (e) {
      logger.error("스마트택배 API 호출 실패:", e);
      res.status(500).json({ error: "배송조회 중 오류가 발생했습니다.", detail: String(e) });
    }
  }
);
