# 상품 등록 플러그인 검증 — 2026-10-07

버전: **0.1.1**. 설치 진입점은 `scripts/plugin-start.mjs`, MCP 서버는 `src/plugin-mcp.mjs`입니다.

## 확인한 내용

- Windows / Node 24.19.0에서 **113 tests / 113 pass / 0 fail / 0 cancelled / 0 skipped**, 종료 코드 0.
- MCP 도구 10개, 원문·이미지·초안 연결, 누락 질문, 단일 검토와 기존 공통 등록 실행기의 연결.
- 정상 완료 및 중간 저장 불일치 시 생성된 상품 ID 보존과 중복 생성 방지.
- 시즌 포함/제외 실행기, 모든 일차·식사, 참조정보 드롭다운, URL/이미지 제한과 이미지 해시 검증.
- 동시에 시작한 설치의 단일 실행, 실패 설치 정리·재시도, 코드 변경 시 별도 실행 환경과 기존 작업 기록 유지.
- 깨끗한 개인 데이터 폴더에서 첫 실행 설치: npm 잠금 버전 의존성 96개, Chromium 확인, 별도 Python 환경과 openpyxl 설치.
- 사용자 설정과 분리한 실제 Codex CLI 환경에서 마켓플레이스 추가와 `eoding-product-register@eoding-auto` 설치.
- Codex 설치 캐시의 진입점을 SDK 클라이언트로 실행해 MCP 연결, 도구 10개 조회, 스키마, 가상 엑셀 원문 접수와 작업 조회 확인.
- 설치 후 이동된 Python 가상환경에서 실제 엑셀 읽기, Chromium의 격리된 빈 페이지 실행 확인.
- 설치 로그는 stderr로 출력하고 stdout은 MCP 프로토콜에 사용.

자동 테스트 실행:

```bash
cd plugins/eoding-product-register
npm ci --ignore-scripts
node node_modules/playwright/cli.js install chromium
npm test
```

## 검증 경계

전체 등록 흐름 시험은 실제 공통 실행기와 Chromium을 사용하지만 ERP 요청은 격리 fixture로 처리합니다. 기본상품 생성은 `basic-simulated-ui`입니다. 실제 ERP에서 새 상품을 저장하거나 기존 상품을 변경하지 않았습니다.

실제 ERP의 모든 화면 변형, 모든 AI 앱의 설치 UI, 모든 직원 PC 환경, 원문 접수부터 실등록까지의 20분 목표는 검증하지 않았습니다. GitHub Actions에는 Windows와 Linux 검사를 구성했으며 실행 결과는 해당 워크플로에서 확인합니다.

로컬 stdio MCP를 제공하며 웹 전용 AI를 위한 원격 HTTP MCP는 제공하지 않습니다. 행사 생성·호텔 배정·판매 공개·기존 상품 덮어쓰기는 범위에 포함하지 않습니다. 실제 ERP 운영 검증에는 지정한 원문과 계정으로 한 건의 등록 결과 확인이 필요하고 검토 화면 승인은 실제 사용자가 수행합니다.
