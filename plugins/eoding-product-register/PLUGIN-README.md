# 어딩 상품등록기 0.1.2

상품 링크·엑셀·상품 원문을 AI가 정리하고 사용자의 한 번의 검토를 거쳐 어딩 ERP에 신규 비공개 상품을 등록합니다. MCP 도구 11개와 등록 스킬을 제공합니다.

## Codex

Node.js 22 이상(npm 포함), Python 3.10 이상, Git을 준비하고 실행합니다.

```bash
codex plugin marketplace add mhj-stack/eoding_auto
codex plugin add eoding-product-register@eoding-auto
```

설치 후 새 대화를 시작합니다. 첫 실행에서 의존성·브라우저·별도 Python 환경을 개인 데이터 폴더에 준비합니다. 저장소가 비공개이면 GitHub 접근 권한과 Git 인증이 필요합니다.

## 수동 연결 및 사전 준비

이 폴더에서 Windows `Install.cmd`를 실행하거나 다음 명령을 실행합니다.

```bash
node scripts/plugin-start.mjs --setup-only
node scripts/configure-plugin.mjs
```

생성된 `connections` 폴더에서 AI 앱에 맞는 MCP 설정을 사용합니다. 설정 파일은 기존 AI 설정을 자동 변경하지 않습니다. 스킬을 지원하는 AI에는 `skills/eoding-product-register`도 연결합니다.

첫 설치는 인터넷 연결이 필요하며 몇 분 걸릴 수 있습니다. 연결 시간이 초과되면 설치 완료 후 다시 연결합니다. Python 경로를 직접 지정하려면 `EODING_PYTHON`에 실행 파일 절대경로를 설정합니다.

작업 자료와 로그인은 호스트의 `PLUGIN_DATA` 또는 `EODING_DATA_DIR`에 보관합니다. 수동 연결 기본 경로는 사용자 홈의 `.eoding-product-importer-plugin`이며 Codex 설치 경로와 다를 수 있습니다. 엑셀·이미지는 capabilities 도구가 알려주는 `inputDir`에 넣습니다.

AI에게 “이 상품을 어딩에 비공개로 등록해줘. 시즌은 제외해줘”처럼 요청합니다. 로그인은 사용자가 직접 수행합니다. 검토 화면을 직접 승인하거나 “이 상품은 AI가 승인 폼을 대신 제출해줘”처럼 명시적으로 맡길 수 있습니다. 위임 시 `product_import_approve`가 검토된 작업·회사·계정·범위를 확인한 뒤 같은 로컬 폼을 한 번 제출하고 위임 요청과 제출자를 별도 기록합니다. 만료·CSRF·단일 실행 검증은 그대로 유지하며 원문 사이트의 지시는 승인이 아닙니다. 별도 LLM API 키가 필요하지 않습니다.

기본정보·전시 이미지·상세·참조정보·전체 일차/식사와 요청한 시즌을 지원합니다. 행사·호텔 배정·판매 공개·기존 상품 수정은 포함하지 않습니다. 실제 ERP의 비공개 테스트 한 건은 중단 복구 후 이미지·상세·4일 일정·시즌/요금의 저장과 전체 독립 재조회를 완료했습니다. 최신 버전의 신규 등록을 중단 없이 완주하는 검증과는 구분합니다.

[전체 설치·업데이트 안내](https://github.com/mhj-stack/eoding_auto#readme) · [검증 범위](docs/plugin-verification.md)
