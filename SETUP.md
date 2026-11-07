# 설정 및 구조 안내

대한항공 홈페이지 **보너스 좌석 조회**의 공개 스냅샷(하루 1회 갱신, 향후 약 360일)을 매일 한 번 모아서

- 미주·유럽 26개 도시 × 왕복 × 12개월의 일등석(F)·프레스티지(P)·프레스티지 승급(U) 현황을 한 화면에 보여주고 (GitHub Pages)
- 전날보다 **새로 열린 일등석·프레스티지 좌석**을 텔레그램 단톡방에 알려줍니다.

로그인이나 SKYPASS 계정은 쓰지 않습니다. 실시간 정보가 아니므로 예약 전 공식 홈페이지에서 확인하세요.

## 구성

| 경로 | 역할 |
|---|---|
| `routes.json` | 대상 도시, 조회 개월 수, 알림 좌석 종류(`alertClasses`), 요청 간격 |
| `scripts/collect.mjs` | 수집 → `docs/data/latest.json`, 새로 열린 좌석 → `docs/data/changes.json` + 텔레그램 |
| `scripts/lib.mjs` | 응답 정규화, 변화 감지, 메시지 생성 (테스트: `node --test test/lib.test.mjs`) |
| `docs/index.html` | 공유 페이지 |
| `reports/YYYY-MM-DD.md` | 매일 쌓이는 데일리 리포트 (새로 열린 좌석 + 노선별 요약). 최신본은 [`reports/latest.md`](reports/latest.md) |
| `.github/workflows/collect.yml` | 매일 23:47 KST 실행, 수동 실행 시 `telegram-test` / `quick` 모드 |

## 설정

1. **Settings → Secrets and variables → Actions → New repository secret**
   - `TELEGRAM_BOT_TOKEN`: BotFather가 준 토큰
   - `TELEGRAM_CHAT_ID`: 단톡방 ID (`-100…` 형태)
2. **Settings → Pages**: Source `Deploy from a branch`, Branch `main` / 폴더 `/docs`
3. **Actions → 보너스 좌석 수집 → Run workflow** 에서 `telegram-test` → `quick` → `collect` 순서로 실행

## 동작 메모

- 한 번 실행에 약 620회 요청을 1.5~3초 간격으로 보냅니다(약 25분).
- 일부 요청이 실패하면 그 달은 이전 데이터를 유지하고, 페이지에 "수집 실패"로 표시합니다. 실패가 30%를 넘으면 텔레그램으로 경고합니다.
- 첫 수집은 기준점만 만들고 알림을 보내지 않습니다. 다음 날부터 바뀐 좌석만 알립니다.
- 도시 추가·삭제는 `routes.json`만 고치면 됩니다.
