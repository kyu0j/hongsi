# iOS 앱스토어 제출용 IPA 만들기

홍시는 앱과 위젯을 함께 빌드해 하나의 IPA로 만들어요. GitHub Actions에서 빌드한 파일을 받아 App Store Connect에 제출할 수 있어요.

## 준비할 것

| 준비물 | 용도 |
| --- | --- |
| Apple Developer Program 가입 | 앱스토어 배포 인증서와 프로파일을 만들 때 필요해요. |
| Apple Distribution 인증서와 개인키를 포함한 `.p12` 파일 | 앱과 위젯에 배포용 서명을 해요. |
| `.p12` 내보내기 비밀번호 | 빌드 서버에서 인증서를 가져올 때 사용해요. |
| 앱용 App Store Connect 프로파일 | `dev.kyuyoung.hongsi`의 배포 권한을 확인해요. |
| 위젯용 App Store Connect 프로파일 | `dev.kyuyoung.hongsi.widgets`의 배포 권한을 확인해요. |

App Store Connect에 실제 파일을 올리기 전에는 해당 Bundle ID로 앱도 등록해야 해요. 위젯을 별도의 판매용 앱으로 등록할 필요는 없어요.

## 1. 앱 ID와 공유 그룹 설정하기

[Apple Developer의 Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list)에서 다음 두 App ID를 확인하거나 등록해 주세요.

| 항목 | Bundle ID | 필요한 설정 |
| --- | --- | --- |
| 홍시 앱 | `dev.kyuyoung.hongsi` | App Groups, Push Notifications |
| 홍시 위젯 | `dev.kyuyoung.hongsi.widgets` | App Groups |

App Group `group.dev.kyuyoung.hongsi`를 등록하고 앱과 위젯 양쪽에 연결해 주세요. 두 App ID와 프로파일은 같은 개발자 팀에 속해야 해요. 앱과 위젯의 Keychain 공유 설정은 프로젝트에 포함돼 있어요.

## 2. 배포 인증서 만들기

1. Xcode의 Apple Account 설정에서 개발자 계정을 추가하고 해당 팀을 선택해 주세요.
2. 인증서 관리 화면에서 **Apple Distribution** 인증서를 만들어요. 이미 같은 팀의 유효한 인증서와 개인키가 있다면 사용할 수 있어요.
3. macOS의 **키체인 접근**을 열고 **나의 인증서**에서 해당 인증서를 찾아요.
4. 인증서를 펼쳤을 때 개인키가 함께 있는지 확인한 뒤 `.p12` 형식으로 내보내요.
5. 내보낼 때 정한 비밀번호를 보관해 주세요.

인증서만 담긴 `.cer` 파일로는 서명할 수 없어요. 개인키가 포함된 `.p12`가 필요해요. 기존 인증서를 사용하는 경우 개인키가 있는 Mac에서 내보내야 해요.

## 3. 프로비저닝 프로파일 두 개 만들기

Apple Developer의 **Profiles**에서 **App Store Connect** 배포 유형을 선택해요.

1. App ID `dev.kyuyoung.hongsi`를 선택해요.
2. 앞에서 준비한 Apple Distribution 인증서를 선택하고 프로파일을 생성해요.
3. `.mobileprovision` 파일을 다운로드해요.
4. `dev.kyuyoung.hongsi.widgets`에도 같은 과정을 반복해요.

두 프로파일 모두 같은 배포 인증서를 선택해 주세요. 개발용이나 Ad Hoc 프로파일은 이번 workflow에 사용할 수 없어요. App Groups나 Push Notifications 설정을 바꿨다면 프로파일을 다시 생성해야 해요.

## 4. GitHub Secrets 등록하기

저장소의 **Settings → Secrets and variables → Actions → Secrets**에서 아래 네 개를 추가해 주세요.

| Secret | 넣을 값 |
| --- | --- |
| `IOS_CERTIFICATE_BASE64` | `.p12` 파일을 Base64로 변환한 값 |
| `IOS_CERTIFICATE_PASSWORD` | `.p12` 내보내기 비밀번호 원문 |
| `IOS_APP_PROFILE_BASE64` | 앱용 `.mobileprovision`을 Base64로 변환한 값 |
| `IOS_WIDGET_PROFILE_BASE64` | 위젯용 `.mobileprovision`을 Base64로 변환한 값 |

Mac에서는 다음 명령을 **한 번에 하나씩** 실행하면 변환한 값이 클립보드에 복사돼요. 파일 경로는 실제 파일로 바꿔 주세요.

```bash
base64 -i '/경로/홍시배포인증서.p12' | tr -d '\n' | pbcopy
```

```bash
base64 -i '/경로/홍시앱.mobileprovision' | tr -d '\n' | pbcopy
```

```bash
base64 -i '/경로/홍시위젯.mobileprovision' | tr -d '\n' | pbcopy
```

Android와 서버 workflow에 등록한 `HONGSI_API_URL`, 학교 주소 등 공통 URL Secrets 20개도 그대로 사용해요. 목록은 [`url-keys.json`](../crates/config/url-keys.json)에 있어요. iOS용으로 다른 이름을 만들어 중복 등록할 필요는 없어요.

개발자 Team ID와 프로파일 UUID는 프로파일에서 읽고, 빌드용 임시 Keychain 비밀번호는 자동으로 만들어요. 별도의 Secret은 필요하지 않아요. APNs 발송용 `.p8` 키는 서버 설정에 사용하는 값이며, 이번 IPA 서명용 Secrets에 넣지 않아요.

## 빌드와 파일 받기

[workflow](../.github/workflows/ios.yml)는 다음과 같이 실행돼요.

| 실행 계기 | 결과 |
| --- | --- |
| `main` 또는 `master`에 push | 코드에 적힌 버전으로 IPA를 만들고 `hongsi-ios` artifact에 올려요. |
| Actions에서 수동 실행 | 선택한 코드로 빌드해요. 버전을 입력하면 해당 버전을 적용해요. |
| GitHub Release 발행 | 릴리스 태그를 적용하고 해당 Release에 IPA를 첨부해요. |

정식 Release 태그는 `v0.2.3`처럼 작성해 주세요. 파일 이름은 `hongsi-0.2.3-ios-appstore.ipa`예요. 사전 릴리스에서는 기존 공통 버전 스크립트에 따라 코드의 숫자 버전을 유지하고, 파일 이름에 사전 릴리스 태그를 반영해요.

앱과 위젯은 같은 버전과 빌드 번호를 사용해요. 빌드 번호는 Actions 실행 번호와 재실행 횟수로 계산해요. 같은 버전을 다시 빌드해도 빌드 번호가 달라져요.

서명 설정이 빠졌거나 만료됐으면 빌드 초기에 실패해요. 인증서와 개인키는 임시 Keychain에 가져오며, 종료 단계에서 생성한 파일과 Keychain을 정리해요. 서명과 내보내기 처리는 [`ios-release.mjs`](../app/scripts/ios-release.mjs)에 분리돼 있어요.

## 앱스토어에 제출하기

이번 workflow는 IPA 생성과 GitHub 첨부까지 해요. App Store Connect 자동 업로드나 심사 제출은 하지 않아요. 따라서 App Store Connect API 키도 필요하지 않아요.

1. App Store Connect에 Bundle ID `dev.kyuyoung.hongsi`로 앱을 등록해요.
2. Mac의 Transporter에서 개발자 계정으로 로그인하고 생성된 IPA를 업로드해요.
3. App Store Connect에서 처리가 끝나면 TestFlight 또는 앱스토어 버전에 빌드를 연결해요.
4. 앱스토어 공개를 원하면 소개, 스크린샷, 개인정보 관련 정보와 심사 정보를 작성하고 심사를 요청해요.

이 IPA는 앱스토어 제출용이라 다운로드한 파일을 눌러 바로 설치하는 방식은 아니에요. 설치 테스트는 TestFlight를 사용할 수 있어요. IPA 빌드 성공과 Apple의 업로드 검증 또는 심사 통과는 별개예요.

## 공식 안내

- [Apple 배포 프로파일 생성](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile/)
- [Apple 인증서 생성 및 내보내기](https://help.apple.com/xcode/mac/current/en.lproj/dev154b28f09.html)
- [GitHub Actions의 Apple 인증서 설치](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)
