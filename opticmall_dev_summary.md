# OPTICMALL 개발 현황 요약
## 2026-07-02 기준

## 프로젝트 정보
- **사이트**: https://opticmall.co.kr
- **GitHub**: https://github.com/WIZOPTIC/opticmall (branch: main)
- **Firebase 프로젝트**: opticmall
- **배포**: GitHub Desktop → Push origin → GitHub Pages 자동 배포
- **작업폴더**: `opticmall소스파일\opticmall\` (.git 있는 곳)

## 파일 목록 (14개)
index.html, join.html, admin.html, brand.html, brands.html,
list.html, product.html, cart.html, order.html, order-success.html,
order-fail.html, mypage.html, terms.html, privacy.html

## Firestore 데이터 구조

### products 컬렉션 (현재 구조 - 다중 색상)
```
products/{id}
  brandId, brandName, brandOwnerUid
  modelName, barcode, size, category, type
  price, discountRate, salePrice
  colors: [
    { colorName, stock, mainImageUrl, detailImageUrls[] }
  ]
  mainImageUrl (첫번째 색상 대표)
  colorNames[] (색상 칩용)
  status ('pending'→관리자 승인→'approved')
  createdAt, approvedAt
```
- **기존 테스트 상품**: 구버전 단일 color/stock 구조 → 실운영 전 초기화 예정
- **초기화 대상**: products, carts, orders, Storage products/
- **유지**: users, brands, promotions

### brands 컬렉션
```
brands/{id}: ownerUid, brandName, logoUrl, createdAt
```

### users 컬렉션
```
users/{uid}: role(master/submaster/brand/member), approval_status, 
             member_level, purchase_level
```

### orders 컬렉션
```
orders/{id}:
  orderId, userId, userName, userEmail
  items: [{ productId, productName, mainImageUrl, selectedColor, 
            selectedColorIdx, qty, unitPrice, subtotal, discountRate }]
  totalAmount, shippingFee, productAmount
  shippingAddress: { addr1, addr2, zipcode }
  receiver: { name, phone }
  status: 'paid'|'preparing'|'shipping'|'delivered'|
          'cancel_requested'|'return_requested'|'cancel_completed'|'cancelled'
  cancelReason, cancelType('before_ship'|'after_ship')
  returnShippingFee, expectedRefund
  cancelRequestedAt, cancelCompletedAt
  paymentKey (토스페이먼츠)
```

## 주요 완료 기능

### 상품 등록 (brand.html)
- 카드 방식 UI: 모델 1개 = 카드 1개
- 색상 추가: 최소 1개 ~ 최대 10개, 색상별 사진(메인+상세4장)+재고 각각 등록
- 등록 중 정중앙 오버레이 팝업 (진행상황 실시간 표시)
- 이미지 경로 중복 방지: `c${ci}_${slot}_${rand}` 패턴
- 상품 자체 할인율(discountRate) 입력 → salePrice 자동 계산
- 검색 기능 (모델명/바코드/색상)
- 수정 모달: 모든 항목 + 이미지 교체 가능

### 관리자 (admin.html)
- 회원 승인/거절, 역할 변경
- 상품 승인/반려
- 전체 상품 수정 모달 (마스터 전체 권한, Storage 이미지 교체)
- 검색 기능 (모델명/바코드/브랜드/색상)
- **취소/반품 관리 탭** (NEW):
  - 목록: 요약 표시, 행 클릭 시 상세 모달
  - 상세 모달: 주문정보/배송지/상품목록/환불금액 표시
  - 환불완료 버튼: 토스페이먼츠 콘솔에서 먼저 환불 후 클릭 → 재고 복구 + 상태 변경
  - 반려 버튼: 사유 입력 후 원래 상태로 복구

### 상품 목록/상세 (list.html, product.html)
- 4:3 비율 이미지
- 색상 칩 표시 (최대 6개 + 나머지 +N 표시)
- 상세페이지: 색상 버튼 클릭 시 메인사진/썸네일/상세사진 전환
- 할인율 표시: 원가 취소선 + 빨간 할인율 + 할인가
- 재고있음 필터: colors 배열 또는 p.stock 모두 지원

### 장바구니 (cart.html)
- 장바구니 담기 시 **재고 트랜잭션 차감** (Firestore transaction)
- 수량 변경 시 재고 조정 (증가→차감, 감소→복구)
- 삭제 시 재고 복구
- 재고 체크: colors[selectedColorIdx].stock 우선, p.stock 호환
- 가격 계산: salePrice 우선 적용
- 선택된 색상 표시 ("블랙 · 2개")

### 주문/결제 (order.html)
- TossPayments 연동 (테스트키: test_ck_P9BRQmyarYDRQ9WY4jj2VJ07KzLN)
- 다중 배송지 (addresses 서브컬렉션, 기본 배송지)
- 카카오 우편번호 API
- 배송비: 10만원 이상 무료, 미만 3,500원, 제주/도서 3,000원 추가
- 할인가(salePrice) + 이벤트 할인 중 더 높은 쪽 자동 적용
- 주문 저장 시 items에 mainImageUrl, selectedColor, selectedColorIdx 포함

### 마이페이지 (mypage.html)
- 주문 내역: 상품 이미지 + 색상 표시
- **취소/반품 신청 모달** (NEW):
  - 발송 전(paid/preparing): 전액 환불
  - 발송 후(shipping/delivered): 배송지 주소 기반 택배비 자동 계산
    - 일반: 왕복 ₩7,000
    - 제주: 왕복 ₩13,000
    - 도서산간: 왕복 ₩20,000
  - 사유 선택 시 환불액 실시간 재계산 (불량/오배송은 전액 환불)
  - 신청 후 상태: cancel_requested / return_requested
- 출고완료(shipping) 이후: 취소 불가, 반품 신청만 가능

### 기타
- 로그인 유지 체크박스 (LOCAL vs SESSION persistence)
- 구매등급: 화이트/실버/골드/플래티넘/옵틱마스터 (누적 구매액 기준)
- 색상 도트 자동 매핑 (블랙→#222, 실버→#C0C0C0 등)
- CNAME: opticmall.co.kr 연결 완료

## 색상 도트 매핑 (getColorDot)
블랙→#222, 화이트→#f0f0f0, 실버→#C0C0C0, 골드→#C9A84C,
브라운→#8B4513, 레드→#E53935, 블루→#1976D2, 핑크→#E91E8C,
그린→#388E3C, 퍼플→#7B1FA2, 기타→#888

## 구매등급
화이트(0~100만)/실버(100~300만)/골드(300~500만)/플래티넘(500~1000만)/옵틱마스터(1000만+)

## 배송비 정책
- 10만원 이상: 무료
- 10만원 미만: ₩3,500
- 제주/도서산간 추가: ₩3,000

## 반품 택배비 정책
- 일반: 왕복 ₩7,000
- 제주: 왕복 ₩13,000
- 도서산간: 왕복 ₩20,000
- 상품불량/오배송: 무료 (판매자 귀책)

## 주문 상태값
- payment_pending: 결제대기
- paid: 결제완료
- preparing: 출고준비중
- shipping: 배송중
- delivered: 배송완료
- cancel_requested: 취소신청 (환불 대기)
- return_requested: 반품신청
- cancel_completed: 취소/환불완료
- cancelled: 취소됨

## 다음 작업 예정
- [ ] 실서비스 전 Firestore 초기화 (products, carts, orders, Storage)
- [ ] 토스페이먼츠 실서비스 키 발급 및 교체
- [ ] Firebase Functions로 자동 환불 API 연동 (Firebase CLI 설치 필요)
- [ ] 상품 DB 정식 등록 (새 colors 구조로)

## Firebase 설정
- 프로젝트: opticmall
- Storage: products/{uid}/{파일명} 패턴
- Auth: Email/Password
- Firestore: asia-northeast3
- Blaze(종량제) 플랜 사용 중

## TossPayments
- 테스트키: test_ck_P9BRQmyarYDRQ9WY4jj2VJ07KzLN
- 실서비스 전환 시 사업자 서류 제출 및 라이브 키 발급 필요
- 주의: 카카오페이 테스트 시 실제 카카오페이에서 출금→즉시 환불됨

## 현재 outputs 폴더 파일 위치
/mnt/user-data/outputs/ 에 최신 14개 파일 저장됨
