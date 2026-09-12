# Client package 전달 계약

P00-C02 결정. 공통 package의 원본은 GCR이고 CD는 고정 tarball을 소비한다. 새 npm registry나 외부 공개 package를 만들지 않는다.

## 경계와 호환성

`@gcr/client-contract`는 runtime dependency와 Node/VS Code 타입이 없는 순수 계약이다. `@gcr/client-core`와 `@gcr/client-executors`는 이 계약을 소비하며 서로 import하지 않는다. Extension·CLI에서 executor를 조립한다. GCR 서버·DB package와 CD source를 client package에서 import하지 않는다.

세 package는 동일한 `0.1.0-alpha.1`부터 시작한다. 초기 artifact는 package identity만 제공하며 실제 리뷰 기능은 P02에서 구현한다. 이 package의 코드는 CD와 같은 Apache-2.0으로 배포하고 재사용 코드의 원래 notice를 보존한다. 서버 전체의 라이선스를 변경하지 않는다.

- 공통 library: Node `>=18.0.0`, ES2022/ESM. CD의 기존 Node 18 bundle target과 호환한다.
- Extension: 기존 `engines.vscode=^1.90.0` 유지. P00-C04에서 최소 1.90.2, 설치된 1.135.0과 조회 당시 stable 1.137.0의 Extension Host를 각각 검증했다. 이 조합의 실제 runtime version을 실행 기록에 남긴다.
- GCR build와 후속 headless CLI: Node `>=22.0.0`. Library compatibility와 독립 실행용 Node 지원 범위를 구분한다.

## 생성·검증

GCR root에서 실행한다.

```sh
pnpm install --frozen-lockfile
pnpm pack:clients --verify
```

`artifacts/client-packages/<version>/`에 세 `.tgz`와 SHA-256 `manifest.json`이 생성된다. 이 디렉터리는 Git에서 제외한다. Script는 clean build, dependency 경계, tarball 내용, exact version 치환, 임시 폴더의 offline install/import를 검증한다. 같은 version에 다른 내용이 있으면 덮어쓰지 않고 실패한다. 내용 변경 시 세 version과 export된 package identity를 함께 올린다. `GCR_CLIENT_MIN_NODE=/absolute/path/to/node18`을 설정하면 같은 설치 artifact를 최소 runtime으로도 import한다.

## CD 소비와 실제 설치 위치

P02-C01의 계약 호환성 검사부터 CD 저장소의 `vscode-extension/vendor/gcr/<version>/`에 생성한 네 파일을 복사하고 hash를 대조한 뒤 소스 변경과 함께 commit한다. 전달 시점의 GCR SHA와 package hash를 CD 검증 기록에 남긴다. 같은 version 디렉터리는 교체하지 않는다.

P02-C01에서는 contract만 `devDependencies`에 설치해 공통 fixture와 CD production 타입·normalizer의 호환성을 검사한다. 이때 core/executors는 identity만 제공하므로 실행 backend에 연결하지 않는다. 세 tarball과 manifest는 함께 보관하며 vendor/test 자료는 VSIX에서 제외한다. P02-C07에서 실제 구현된 세 package를 runtime dependency로 전환하고 bundle·license 포함 여부를 검증한다.

P02-C07의 CD `vscode-extension`에서 실행할 설치 형태는 다음과 같다. 아래 `0.1.0-alpha.1`은 최초 artifact의 예시이며 기능 통합 때 실제 고정한 version으로 모두 치환한다.

```sh
npm install --save-exact --ignore-scripts \
  ./vendor/gcr/0.1.0-alpha.1/gcr-client-contract-0.1.0-alpha.1.tgz \
  ./vendor/gcr/0.1.0-alpha.1/gcr-client-core-0.1.0-alpha.1.tgz \
  ./vendor/gcr/0.1.0-alpha.1/gcr-client-executors-0.1.0-alpha.1.tgz
npm ci
npm run build
```

CD의 `package.json`은 repository 상대 `file:vendor/...`와 lockfile integrity를 고정한다. 세 artifact를 함께 설치하므로 core/executors의 exact contract dependency가 동일한 root package로 해소된다. CD bundler가 runtime 코드를 VSIX에 포함하고 license/notice도 함께 담는다. 설치 사용자에게 GCR checkout·개발자의 절대 경로·private registry 자격 증명이 필요하지 않다.

Headless 배포는 P02-C06에서 `apps/cli`를 Node 22용 단일 실행 bundle과 license/notice를 가진 `gcr-cli-<version>.tgz`로 만든다. CD의 같은 vendor release 디렉터리에 선택 설치 artifact로 전달하고 `npm install -g ./gcr-cli-<version>.tgz`로 설치한다. CLI 배포물의 생성·설치·실제 실행은 P02-C06의 완료 조건이며 현재 존재한다고 표시하지 않는다.

Extension Host 검증은 [VS Code 공식 testing 절차](https://code.visualstudio.com/api/working-with-extensions/testing-extension)를 따른다. 1.90.2는 [기존 최소 버전 계열](https://code.visualstudio.com/updates/v1_90)의 patch 버전이다.
