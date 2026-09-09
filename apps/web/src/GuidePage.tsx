import {
  ArrowRight,
  BookOpenText,
  CircleAlert,
  ExternalLink,
  GitPullRequest,
  KeyRound,
  MessageSquareText,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { loadCurrentUser, type User } from './api.ts';
import { AppHeader } from './AppHeader.tsx';
import { DocumentationNav } from './DocumentationNav.tsx';
import { reviewGrades, reviewSeverityLevelSchema, reviewSeverityLevels } from '@gcr/contracts';
import { ReviewGrade } from './ReviewGrade.tsx';

const githubPatDocs =
  'https://docs.github.com/en/enterprise-server@3.21/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens';
const githubApiAuthDocs =
  'https://docs.github.com/en/enterprise-server@3.21/rest/authentication/authenticating-to-the-rest-api';
const githubCredentialSecurityDocs =
  'https://docs.github.com/en/enterprise-server@3.21/rest/authentication/keeping-your-api-credentials-secure';
const githubIssueCommentDocs =
  'https://docs.github.com/en/enterprise-server@3.21/rest/issues/comments#create-an-issue-comment';

export function GuidePage() {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadCurrentUser(controller.signal).then(
      (currentUser) => setUser(currentUser),
      (error: unknown) => {
        if (!controller.signal.aborted) console.error(error);
      },
    );
    return () => controller.abort();
  }, []);

  return (
    <div className="guide-page">
      <AppHeader user={user} />
      <div className="guide-shell">
        <aside className="guide-nav" aria-label="사용 가이드 목차">
          <div className="guide-nav-title">
            <BookOpenText size={16} />
            <strong>문서</strong>
          </div>
          <DocumentationNav currentPath="/guide" />
          <p className="guide-nav-section-title">사용 가이드 목차</p>
          <a href="#start">시작하기</a>
          <a href="#profile">개인 프로필</a>
          <a href="#ghes-credential">GHES credential</a>
          <a href="#register-repository">Repository 등록</a>
          <a href="#analysis-provider">자동 분석 모델 설정</a>
          <a href="#analysis-skills">분석 Skills와 report</a>
          <a href="#review-grades">코드 품질 등급</a>
          <a href="#review-flow">Review와 Chat</a>
          <a href="#review-memory">Memory와 PR 대화</a>
          <a href="#code-navigation">파일 tree와 코드 이동</a>
          <a href="#troubleshooting">문제 해결</a>
          <a href="#security">보안 점검</a>
        </aside>

        <main className="guide-main">
          <header className="guide-hero" id="start">
            <p className="eyebrow">Product guide</p>
            <h1>Git Code Reviewer 사용 가이드</h1>
            <p>
              시스템 관리자는 GHES와 ChatGPT account를 연결하고 사용 범위를 지정합니다. 일반
              사용자는 권한이 부여된 repository의 PR을 검토하고, 허용된 account·model·effort로
              Chat을 사용합니다.
            </p>
            <div className="guide-role-strip">
              <span>
                <ShieldCheck size={15} /> 시스템 관리자
              </span>
              <p>사용자, tenant, GHES, Chat account와 repository polling을 설정합니다.</p>
              <span>
                <GitPullRequest size={15} /> 일반 사용자
              </span>
              <p>허용된 PR의 finding, diff, Git graph, evidence와 Chat을 사용합니다.</p>
            </div>
          </header>

          <section className="guide-section" id="profile">
            <div className="guide-section-heading">
              <KeyRound size={19} />
              <div>
                <h2>개인 프로필·Prompt·비밀번호</h2>
              </div>
            </div>
            <p>
              GNB의 <strong>내 프로필</strong>에서 표시 이름, 사용자 이름 또는 subject, role, 인증
              방식과 tenant membership을 확인할 수 있습니다. Local account 사용자는 표시 이름을 직접
              수정할 수 있습니다.
            </p>
            <p>
              <strong>개인 Prompt</strong>에는 답변 길이, 설명 방식, 관심 영역 등 본인의 Review Chat
              지침을 최대 4,000자까지 작성할 수 있습니다. 예를 들어 ‘결론부터 설명하고 보안과
              backward compatibility를 중점적으로 검토해 주세요’라고 입력한 뒤 ‘개인 Prompt 저장’을
              누르세요. 기존 대화에서도 다음 질문부터 적용되며 과거 메시지는 바뀌지 않습니다. ‘내용
              비우기’ 후 저장하면 적용이 해제됩니다.
            </p>
            <p>
              개인 Prompt는 서비스 로그인 사용자별로 저장됩니다. 같은 ChatGPT account를 사용하는
              다른 사용자, 공동 PR 분석과 PR 댓글에는 적용되지 않습니다. Local account와 외부 인증
              계정 모두 설정할 수 있습니다. 입력 내용은 선택한 모델로 전송되므로 비밀번호나 Access
              token을 넣지 마세요. 개인 Prompt는 답변 형식과 근거 검증 규칙을 변경하지 않습니다.
            </p>
            <p>
              비밀번호는 현재 비밀번호를 확인한 뒤 8~128자로 변경합니다. 변경이 완료되면 기존
              session이 모두 종료되므로 새 비밀번호로 다시 로그인해야 합니다. 외부 인증 계정은
              연결된 IdP에서 프로필과 비밀번호를 변경하십시오.
            </p>
            <p>
              시스템관리자는 <a href="/admin?tab=users">설정 → 사용자</a>에서 각 사용자의 휴지통
              버튼으로 계정을 삭제할 수 있습니다. 확인창에 해당 사용자 이름 또는 Subject를 입력해야
              하며 현재 로그인한 본인 계정은 삭제할 수 없습니다. 삭제하면 로그인 세션·개별 권한·개인
              Prompt·Local 비밀번호를 정리하고 사용자 목록에서 제외합니다.
            </p>
            <p>
              삭제한 사용자의 개인 Chat 이력은 retention 정책에 따라 보관하며 다른 사용자에게
              이전하지 않습니다. 공동 PR report·분석 설정·audit 기록과 외부 IdP 원본 계정은
              유지합니다. 삭제 후 같은 사용자 이름·Subject로 재등록하거나 화면에서 복원할 수
              없으므로 일시적인 이용 중지는 사용자 목록의 앱 접근 차단을 사용하세요.
            </p>
          </section>

          <section className="guide-section" id="ghes-credential">
            <div className="guide-section-heading">
              <KeyRound size={19} />
              <div>
                <p className="eyebrow">Administrator</p>
                <h2>GHES credential 발급과 입력</h2>
              </div>
            </div>
            <p>
              개인 관리자 계정보다는 회사가 관리하는 bot 또는 service account를 사용하고, 그
              계정에는 review 대상 repository만 부여하십시오. Source 조회 권한은 Read-only로
              제한하고, PR timeline에 review 결과를 게시하기 위해 Pull requests만 Read and write로
              설정합니다. 현재 registry가 받는 credential은 GHES Personal Access Token(PAT)입니다.
            </p>

            <h3>권장: fine-grained PAT</h3>
            <ol className="guide-steps">
              <li>GHES에서 프로필 사진 → Settings → Developer settings로 이동합니다.</li>
              <li>
                Personal access tokens → Fine-grained tokens → Generate new token을 선택합니다.
              </li>
              <li>Resource owner로 대상 organization을 선택하고 만료일을 지정합니다.</li>
              <li>
                Repository access는 Only select repositories를 선택해 review 대상만 지정합니다.
              </li>
              <li>
                아래 repository permission을 설정한 뒤 organization 승인이 필요하면 승인을 받습니다.
              </li>
            </ol>

            <div className="guide-table-wrap">
              <table className="guide-table">
                <thead>
                  <tr>
                    <th>Permission</th>
                    <th>Access</th>
                    <th>이 서비스에서 쓰는 작업</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>Metadata</code>
                    </td>
                    <td>Read-only</td>
                    <td>Repository 확인과 numeric ID 조회</td>
                  </tr>
                  <tr>
                    <td>
                      <code>Pull requests</code>
                    </td>
                    <td>Read and write</td>
                    <td>Open PR polling, base/head SHA 확인, review 결과 댓글 생성·갱신</td>
                  </tr>
                  <tr>
                    <td>
                      <code>Issues</code>
                    </td>
                    <td>No access</td>
                    <td>
                      Pull requests write 권한으로 PR timeline 댓글 API를 호출하므로 별도 권한
                      불필요
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>Contents</code>
                    </td>
                    <td>Read-only</td>
                    <td>Worker의 HTTPS Git fetch와 diff 생성</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="guide-note">
              Fine-grained PAT 메뉴가 없거나 사내 GHES/organization 정책이 허용하지 않으면 classic
              PAT의 <code>repo</code> scope를 사용할 수 있습니다. <code>repo</code>는 계정이 접근할
              수 있는 private repository 전체로 범위가 넓으므로 별도 service account와 짧은
              만료·회전 주기를 적용하십시오. Administration, Contents write와 Workflows 권한은
              필요하지 않습니다.
            </p>

            <h3>관리 화면 입력값</h3>
            <dl className="guide-fields">
              <div>
                <dt>연결 이름</dt>
                <dd>
                  연결을 구분하는 관리용 이름입니다. 예: <code>GitHub.com · org-name</code>
                </dd>
              </div>
              <div>
                <dt>API base URL</dt>
                <dd>
                  GitHub.com은 <code>https://api.github.com</code>을 입력합니다. Organization이나
                  repository 경로는 붙이지 않습니다.
                </dd>
              </div>
              <div>
                <dt>Web base URL</dt>
                <dd>
                  GitHub.com은 <code>https://github.com</code>을 입력합니다. Git fetch와 원본 link에
                  사용하며 <code>/org-name</code> 같은 organization 경로는 넣지 않습니다.
                </dd>
              </div>
              <div>
                <dt>Credential label</dt>
                <dd>
                  이 서비스 내부의 관리용 식별자입니다. secret이나 GHES username이 아닙니다. 예:{' '}
                  <code>ghes-review-publisher</code>. 같은 GHES와 같은 label로 다시 등록하면 기존
                  credential의 token이 교체되고 version이 증가합니다.
                </dd>
              </div>
              <div>
                <dt>Access token</dt>
                <dd>
                  GHES가 발급 화면에서 보여 준 token 원문만 입력합니다. <code>Bearer </code> 접두어,
                  따옴표, username, URL은 넣지 않습니다. 저장 후 원문은 다시 표시되지 않습니다.
                </dd>
              </div>
              <div>
                <dt>Token 만료일</dt>
                <dd>
                  GHES에서 정한 날짜와 같게 입력하면 만료된 credential의 사용을 차단할 수 있습니다.
                </dd>
              </div>
            </dl>
            <p className="guide-note">
              사내 GHES는 회사에서 운영하는 GitHub 사이트 주소를 사용합니다. 예를 들어 사이트가
              <code> https://github.company.internal</code>이면 API base URL은
              <code> https://github.company.internal/api/v3</code>, Web base URL은
              <code> https://github.company.internal</code>입니다. Github.com 주소와 혼용하지
              않습니다.
            </p>
            <p className="guide-note">
              등록된 연결은 GHES 연결 목록의 <strong>연결 수정</strong>에서 이름, API/Web URL,
              credential label과 만료일을 변경할 수 있습니다. 새 access token은 선택 입력이며 비워
              두면 기존 암호문과 credential version을 유지합니다. 단, API/Web origin을 변경할 때는
              새 token을 입력해야 합니다. 저장 후에는 연결 테스트를 다시 실행해야 polling과 Git
              작업에 credential을 사용할 수 있습니다. 같은 GHES instance를 credential 여러 개가
              공유하면 이름과 API/Web URL은 수정할 수 없습니다.
            </p>

            <div className="guide-warning">
              <CircleAlert size={18} />
              <p>
                연결 테스트는 token identity를 <code>GET /user</code>로 확인합니다. 테스트
                성공만으로 repository 권한과 Git fetch까지 보장되지는 않습니다. Repository 등록,
                Poll now, 첫 분석까지 실행해 전체 경로를 확인하십시오.
              </p>
            </div>
            <div className="guide-links" aria-label="GitHub 공식 문서">
              <a href={githubPatDocs} target="_blank" rel="noreferrer">
                PAT 생성 공식 문서 <ExternalLink size={13} />
              </a>
              <a href={githubApiAuthDocs} target="_blank" rel="noreferrer">
                REST API 인증 <ExternalLink size={13} />
              </a>
              <a href={githubIssueCommentDocs} target="_blank" rel="noreferrer">
                PR timeline 댓글 API <ExternalLink size={13} />
              </a>
              <a href={githubCredentialSecurityDocs} target="_blank" rel="noreferrer">
                Credential 보안 지침 <ExternalLink size={13} />
              </a>
            </div>
            <p className="guide-doc-version">
              공식 문서 link는 GHES 3.21 기준입니다. 문서 상단의 version selector에서 사내 운영
              version을 선택해 메뉴와 지원 범위를 다시 확인하십시오.
            </p>
          </section>

          <section className="guide-section" id="register-repository">
            <div className="guide-section-heading">
              <GitPullRequest size={19} />
              <div>
                <p className="eyebrow">Administrator</p>
                <h2>Repository와 polling 등록</h2>
              </div>
            </div>
            <ol className="guide-steps">
              <li>
                관리 → GHES &amp; Repository에서 connection을 등록하고 연결 테스트를 실행합니다.
              </li>
              <li>
                GitHub 연결과 tenant를 선택하고 Repository URL에 repository 전체 주소를 붙여
                넣습니다.
              </li>
              <li>자동 추출된 Owner와 Repository를 확인하고 polling interval을 설정합니다.</li>
              <li>
                일반 사용자가 필요하면 사용자 권한을 선택하고, 자동 게시할 repository는{' '}
                <strong>분석 완료 후 PR timeline에 review 결과 게시</strong>를 켭니다.
              </li>
              <li>
                Repository 등록 후 Poll now를 실행해 open PR과 마지막 polling 결과를 확인합니다.
              </li>
              <li>
                PR에서 분석을 시작해 report 생성 후 GHES 댓글이 등록되는지 확인합니다. 후속 분석은
                댓글을 새로 만들지 않고 기존 댓글을 갱신합니다.
              </li>
            </ol>
            <h3>GitHub.com repository 입력 예시</h3>
            <dl className="guide-fields">
              <div>
                <dt>GHES 연결</dt>
                <dd>
                  API가 <code>https://api.github.com</code>, Web이 <code>https://github.com</code>인
                  연결을 선택합니다.
                </dd>
              </div>
              <div>
                <dt>Repository URL</dt>
                <dd>
                  <code>https://github.com/org-name/repo-name</code>
                </dd>
              </div>
              <div>
                <dt>자동 추출 결과</dt>
                <dd>
                  Owner: <code>org-name</code> · Repository: <code>repo-name</code>. 두 값을 따로
                  입력할 필요가 없습니다.
                </dd>
              </div>
              <div>
                <dt>Tenant / Polling interval</dt>
                <dd>
                  이 repository를 관리할 tenant(예: Default tenant)를 선택하고 polling interval은{' '}
                  <code>120</code>초처럼 입력합니다.
                </dd>
              </div>
            </dl>
            <p>
              주소 끝의 <code>.git</code>과 trailing slash는 자동으로 정리합니다. PR, branch, file
              페이지 주소는 repository 첫 화면 주소로 바꾸십시오. 선택한 연결과 repository의 host가
              다르면 등록할 수 없습니다. 404는 주소 오타와 private repository 권한 부족 양쪽에서
              발생할 수 있으므로 PAT의 Resource owner가 <code>org-name</code>인지, Repository
              access에
              <code> repo-name</code>가 포함됐는지 확인하십시오. Organization 승인이나 SSO가
              필요하면 해당 절차도 완료해야 합니다.
            </p>
            <p className="guide-note">
              이 연결은 inbound webhook을 열지 않습니다. Server가 지정한 interval에 GHES로 outbound
              요청을 보내고, 변경이 있을 때 Worker가 필요한 commit만 가져옵니다.
            </p>
            <p className="guide-note">
              PR 게시 기능 도입 전에 등록된 repository는 게시가 꺼진 상태로 유지됩니다. Token 교체와
              연결 테스트 후 repository 카드에서 <strong>PR 게시 시작</strong>을 눌러 활성화합니다.
            </p>
            <h3>Review repository 등록 삭제</h3>
            <p>
              관리자 화면의 repository 카드에서 <strong>등록 삭제</strong>를 누르고 확인창에 표시된{' '}
              <code>Owner/Repository</code>를 입력합니다. 등록 목록과 사용자 접근 권한을 제거하고
              polling·대기 작업을 중지합니다. 실행 중인 분석이나 PR 게시가 있으면 삭제를 거부하므로
              Polling을 중지하고 작업이 끝난 뒤 다시 시도하십시오.
            </p>
            <p>
              GitHub 원본 repository, GHES connection·token, 기존 PR 댓글은 삭제하지 않습니다. 기존
              분석·Chat 기록은 retention 정책에 따라 보관하며 같은 repository를 다시 등록하면 남아
              있는 기록을 사용할 수 있습니다. 사용자 접근 권한은 다시 지정해야 합니다.
            </p>
          </section>

          <section className="guide-section" id="analysis-provider">
            <h2>등록된 ChatGPT account로 자동 분석하기</h2>
            <p>
              비활성 ChatGPT account와 비활성 Provider 버전에는 삭제 버튼이 표시됩니다. Account를
              삭제하면 저장된 credential과 사용 권한을 제거하며 복구할 수 없습니다. 기존 분석과 대화
              기록은 남습니다. 활성 Provider나 대기·진행 중인 분석·대화가 참조하는 account는 사용을
              정리한 뒤 삭제하세요. Provider 삭제는 선택 목록에서 버전을 제거하는 동작이며, 이미
              대기 중인 분석을 위해 그 버전의 실행 설정과 암호화된 credential은 보존합니다.
            </p>
            <p>
              시스템 관리자는 Administration → ChatGPT accounts에서 account와 사용할 model ID, 허용
              effort를 등록하고 분석 대상 repository의 tenant 또는 all 권한을 부여합니다. user·group
              전용 권한은 대화에만 사용하며 자동 분석에는 사용할 수 없습니다.
            </p>
            <p>
              <a href="/admin?tab=provider">Administration → 분석 모델</a>에서 ‘등록된 ChatGPT
              account’를 선택하고 Account·Model·Reasoning effort, 파일 병렬 처리 수와 Timeout을
              지정합니다. ‘연결 테스트’는 코드 없이 짧은 응답만 확인합니다. ‘새 버전 저장 및
              활성화’를 누르면 이후 생성되는 분석에 적용됩니다. 분석 프롬프트는 repository의 tenant
              설정을 따릅니다.
            </p>
            <p>
              Model과 effort는 account에 등록된 허용 목록에서 선택합니다. 목록이 부족하면 ChatGPT
              accounts의 모델 목록 조회에서 실제 지원 값을 확인하고 등록하세요. low는 속도를,
              high·xhigh는 깊은 검토를 우선하며 medium은 두 요구 사이의 균형을 맞춥니다. Effort를
              낮추면 복잡한 결함을 놓칠 수 있으므로 같은 PR로 결과를 비교하세요.
            </p>
            <p>
              파일 병렬 처리 수는 1~4개이며 새 설정의 기본값은 4개입니다. 파일 안의 코드 구간은
              순서대로 검토하고, 모든 파일 검토가 끝난 뒤 PR 전체 Summary를 만듭니다. 같은 account의
              분석 요청은 최대 4개, Review Chat은 별도 1개로 제한합니다. Provider의 rate limit에
              도달하면 Retry-After 동안 대기하므로 4배 속도를 보장하지 않습니다. Timeout이나 분석
              예산을 줄여 검토 범위를 생략하는 방식은 사용하지 않습니다.
            </p>
            <p>
              Review Chat에서 선택한 모델은 자동 분석 설정을 바꾸지 않습니다. 기존 PR을 다시
              분석하려면 Workspace에서 새로고침하세요. 같은 commit도 새 revision으로 분석하며 이전
              report는 이력으로 남습니다. Account 인증 갱신은 registry를 공유하지만
              Account·Model·Effort와 병렬 처리 수는 분석 버전에 고정됩니다. 실행 중인 분석의 설정은
              바뀌지 않으며 병렬 처리에서도 Report 파일 순서와 실패·미완료 표시는 유지합니다.
            </p>
            <p>
              ‘데모 분석’은 실제 AI review가 아닙니다. ‘AI review 미수행’ 또는 ‘AI review 실패’가
              표시되면 분석 Provider 설정, account 인증 상태, model ID, tenant 권한을 확인하고 다시
              분석하세요. Coverage는 diff에서 확보한 코드 범위이며 테스트 통과율이나 AI 정확도가
              아닙니다.
            </p>
          </section>

          <section className="guide-section" id="analysis-skills">
            <h2>분석 Skills와 Commit Defender report</h2>
            <p>
              Administration → 분석 Skills에서 분석 관점과 report 형식을 SKILL.md로 편집합니다.
              Built-in에는 correctness, security, maintenance, optimization, review-history, setting
              관점과 unit-comment-block, overall-summary, total-summary 형식이 포함됩니다.
            </p>
            <p>
              기본 관점 6개의 version 2는 Commit Defender 원문의 점검 항목과 Tone을 한국어로
              옮겼으며 전문용어는 영어로 유지합니다. 이미 저장해 활성화한 custom bundle은 자동으로
              덮어쓰지 않습니다. 새 기본 내용을 적용하려면 ‘Built-in을 초안으로 불러오기’로 내용을
              비교·수정한 뒤 ‘Version 저장 및 활성화’를 선택하세요.
            </p>
            <p>
              ‘Perspective 추가’로 새 관점을 만들고 name, title, version과 한국어 지침을 작성하세요.
              이름은 영어 소문자·숫자·hyphen을 사용합니다. 관점을 끄려면 enabled를 false로 바꾸며 세
              form은 활성 상태로 유지해야 합니다. ‘Version 저장 및 활성화’는 전역 설정으로, 이후
              queue에 들어가는 모든 tenant의 분석에 적용됩니다. Tenant별 추가 지침은 분석
              프롬프트에서 관리합니다.
            </p>
            <h3>분석 수준 · Severity Level</h3>
            <p>
              Administration → 분석 프롬프트에서 tenant를 고르고 분석 수준을 선택한 뒤 ‘새 버전 저장
              및 활성화’를 누르세요. 추가 지침은 비워도 됩니다. 기본값은 moderate입니다.
              Model·effort는 분석 Provider에서 따로 설정하며, Severity Level은 검토 범위와 보고할
              comment의 priority 기준을 조절합니다.
            </p>
            <dl>
              {reviewSeverityLevelSchema.options.map((level) => (
                <div key={level}>
                  <dt>
                    <strong>{level}</strong> · {reviewSeverityLevels[level].scope}
                  </dt>
                  <dd>{reviewSeverityLevels[level].description}</dd>
                </div>
              ))}
            </dl>
            <p>
              P1은 화면에서 Info로 표시하는 선택적 개선 제안입니다. Moderate의 한도는 여러 window를
              합친 파일 전체에 적용하고 P2·P3는 개수 제한 없이 유지합니다. Severe에서도 같은 파일에
              문제가 있으면 P0 Praise를 함께 넣지 않습니다. Level 때문에 priority를 올리거나 확인된
              P3를 낮추지 않습니다. 요약은 필터를 통과한 comment를 기준으로 작성합니다.
            </p>
            <p>
              지침과 분석 수준은 하나의 immutable version으로 저장됩니다. 이전 version을 활성화하면
              둘 다 복원되고 ‘기본값 복원’은 추가 지침 없음·moderate로 돌아갑니다. 변경 전 queue에
              들어간 작업과 기존 report는 그대로 유지됩니다. 새 report의 Raw JSON에서
              versions.severity와 versions.prompt로 적용 수준과 version을 확인할 수 있습니다.
            </p>
            <p>
              Version history에서 이전 version을 활성화하거나 Built-in으로 복원할 수 있습니다.
              저장된 본문과 기존 report는 변경되지 않습니다. Queue에 들어간 작업은 그때 고정한 Skill
              bundle/hash를 사용합니다. 변경 사항을 기존 PR에 적용하려면 Workspace에서 새로고침하여
              새 분석을 만드세요.
            </p>
            <p>
              Worker는 line 번호가 있는 window별로 comment를 생성하고 검증된 code segment·unit을
              파일별 Overall Summary와 전체 summary로 집계합니다. 모델 입력은 core 80줄과 경계
              context 12줄로 나누며 호출 예산은 기본 32회입니다. 파일 요약과 전체 요약도 호출 예산에
              포함됩니다. 일부 호출이 실패하거나 출력이 잘리면 성공한 comment를 보존하고 미완료
              범위를 표시합니다.
            </p>
            <p>
              Summary 탭은 PR 전체 요약, 펼쳐진 파일별 검토 요약과 Analyzed File List를 표시합니다.
              전체 요약이 없는 과거 report에는 별도 안내가 표시됩니다. 하단 FNB의 Comments는 Commit
              Defender의 unit-comment-block에 해당하는 AI review comment를 파일별로 표시합니다.
              요약과 상세 의견의 Markdown은 제목, 강조, 목록, 표와 code block으로 표시합니다. 보안을
              위해 raw HTML은 실행하지 않고 외부 이미지는 불러오지 않습니다. 파일 요약이나 Comment의
              본문·여백을 클릭하면 Code 탭의 해당 head/mergeBase line과 inline 설명으로 이동하며
              오른쪽 Chat에서 이어서 질문할 수 있습니다. 파일 수준의 설명에는 line을 만들지
              않습니다. Raw JSON과 Markdown에서도 같은 분석 revision을 확인할 수 있습니다.
            </p>
            <p>
              P0 Praise, P1 Info, P2 Warning, P3 Critical 중 가장 높은 priority를 대표값으로
              표시합니다. P3는 BLOCKED이며 실제 merge나 branch protection을 자동으로 변경하지
              않습니다. PASS는 분석한 범위에서 P3가 없다는 뜻이지 결함이나 보안 문제가 없다는 보증이
              아닙니다. 분석 미완료·미수행·실패·데모 상태와 파일별 검토 상태를 함께 확인하세요. 화면
              아래 Coverage는 코드 수집 범위이고 report의 ‘files 검토 완료’와는 다릅니다.
            </p>
            <p>
              Repository의 PR 게시 설정이 켜져 있으면 새 Skill 기반 분석의 PR timeline 댓글에도
              Overall Summary, AI Comments, Analyzed File List를 게시합니다. AI Comments는 기본으로
              접혀 있으며 의견 수와 파일 수가 표시된 ‘펼쳐 보기’를 누르면 상세 내용을 확인할 수
              있습니다. Markdown export에도 같은 접기 형식을 적용합니다. 길이 제한으로 생략한 항목은
              전체 report 링크에서 확인합니다. 대상 PR 안의 SKILL.md, TODO나 type-ignore 문자열을
              관리자 지침으로 자동 신뢰하지 않으며 Skill에 Secret을 넣으면 안 됩니다.
            </p>
          </section>

          <section className="guide-section" id="review-grades">
            <h2>코드 품질 등급</h2>
            <p>
              Grade는 검토한 코드의 종합 품질 평가입니다. 탁월·우수·양호는 긍정적인 평가이며, 양호는
              경고 등급이 아닙니다. 개선 필요는 주황색, 심각은 빨간색으로 표시합니다.
            </p>
            <div className="guide-table-wrap">
              <table className="guide-table">
                <thead>
                  <tr>
                    <th>화면 표시</th>
                    <th>Grade</th>
                    <th>의미</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(reviewGrades) as Array<keyof typeof reviewGrades>).map((grade) => (
                    <tr key={grade}>
                      <td>
                        <ReviewGrade grade={grade} />
                      </td>
                      <td>
                        <code>{grade}</code>
                      </td>
                      <td>{reviewGrades[grade].description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Grade는 개별 의견의 Priority(P0–P3), 분석 완료 여부, 분석 수준 설정인 Severity Level과
              별개입니다. 양호·우수여도 P2·P3 의견과 분석 제한을 함께 확인하세요. 분석에 제한이
              있으면 검토한 범위에만 해당하는 평가이며, merge 승인이나 결함이 없다는 보장은
              아닙니다. Raw JSON과 저장된 Grade 값은 영어로 유지합니다.
            </p>
          </section>

          <section className="guide-section" id="review-flow">
            <div className="guide-section-heading">
              <MessageSquareText size={19} />
              <div>
                <p className="eyebrow">Reviewer</p>
                <h2>Review workspace와 Chat</h2>
              </div>
            </div>
            <div className="guide-flow">
              <div>
                <strong>1. Worklist</strong>
                <span>Tenant와 Open / Closed / All 상태를 선택하고 PR을 엽니다.</span>
              </div>
              <ArrowRight size={17} />
              <div>
                <strong>2. Summary와 Comments</strong>
                <span>
                  메인 Summary에서 PR·파일 요약을, 하단 Comments에서 상세 의견을 읽습니다.
                </span>
              </div>
              <ArrowRight size={17} />
              <div>
                <strong>3. Chat</strong>
                <span>
                  오른쪽 입력창 아래에서 Account·Model·Effort를 선택하고 현재 revision을 질문합니다.
                </span>
              </div>
            </div>
            <p>
              Worklist의 Closed에는 merge 없이 닫힌 PR과 Merged PR이 모두 포함됩니다. 각 행의 PR
              상태와 검토 평가는 별도 항목이며 Draft는 Open에 포함됩니다. GitHub 상태는 repository의
              polling 주기에 따라 자동 갱신되고 새로고침은 마지막 수집 결과를 다시 불러옵니다.
              동기화에 실패하면 마지막 상태와 오류 안내를 표시합니다. 처음 등록한 repository의 과거
              Closed·Merged PR도 수집하지만 자동 분석하지는 않습니다. 저장된 분석이 없는 Closed PR은
              GitHub 원문으로 열립니다.
            </p>
            <p>
              하단 FNB에서 Comments, Memory, Git graph, Impact, Tests를 전환할 수 있습니다.
              Comment를 선택하면 diff anchor, evidence와 Chat scope가 같은 analysis revision에
              맞춰집니다. Chat account가 보이지 않으면 시스템 관리자에게 account assignment와 model
              policy를 확인해 달라고 요청하십시오.
            </p>
            <p>
              Memory 탭에서 과거 판단과 PR 대화를 관리합니다. 후보 저장과 집단 메모리 승인은{' '}
              <a href="#review-memory">Memory와 PR 대화</a> 절차를 참고하세요.
            </p>
            <p>
              Code·Summary 왼쪽의 패널 toggle로 Files 탐색 영역을 숨기거나 다시 표시할 수 있습니다.
              Chat의 기본 너비는 569px, 하단 Comments의 기본 높이는 280px이며 화면 크기에 맞춰
              조정됩니다. Desktop에서는 경계선을 drag하거나, 경계선에 Tab으로 이동한 뒤 방향키로
              크기를 조절하세요. 더블클릭 또는 Home으로 해당 패널의 기본 크기를 복원합니다. 이전에
              직접 조정한 크기는 유지됩니다.
            </p>
            <p>
              Chat 본문과 입력 글씨는 14px이며 입력창은 기본 5줄, 최소 높이 140px입니다.
              Account·Model·Effort는 입력창 아래에 있고 좁은 패널에서는 Account가 별도 줄로
              표시됩니다. Enter로 전송하고 Shift+Enter로 줄을 바꿉니다.
            </p>
            <p>
              ‘분석 Provider 설정 불러오기’에서 등록된 ChatGPT 분석 모델을 선택하거나,
              Account·Model·Effort를 직접 바꿀 수 있습니다. 사용자에게 허용된 account와 model만
              표시되며 선택값은 다음 질문부터 적용됩니다. Interactive Chat은 모델을 바꿔도 같은
              revision의 대화를 유지합니다. 답변 생성 중에는 모델 변경이 잠기며 기존 실행에는 영향을
              주지 않습니다. OpenAI-compatible batch Provider는 현재 이 선택 목록에 포함되지
              않습니다.
            </p>
            <p>
              ‘이전 대화와 코드 근거’는 PR 분석 revision 선택 메뉴가 아닙니다. 현재 revision에서
              나눈 이전 질문을 고르면 저장된 답변과 파일·라인 범위별 코드 근거를 확인할 수 있습니다.
              저장된 질문이 없으면 입력창에서 먼저 질문하세요.
            </p>
            <p>
              Review assistant 답변은 Markdown 제목·목록·강조·코드·표로 표시됩니다. 질문 원문은
              그대로 보존하며 HTML이나 외부 이미지는 실행·로드하지 않습니다. ‘전체 PR을 merge할 때
              문제는?’처럼 넓게 질문하면 현재 선택한 finding 외에 다른 파일의 검토 내용도 함께
              참고합니다. Interactive Chat이 활성화되어 있으면 고정된 snapshot의 기존 코드와
              테스트도 도구로 조회합니다. 기존 batch report를 수정하거나 테스트를 실행하지는
              않습니다.
            </p>
            <p>
              답변 아래 <strong>관련 코드</strong>에는 사용된 근거를 최대 24개 표시합니다. 각 링크는{' '}
              <code>src/storage.ts · L10–14 · 변경 코드</code>처럼 파일·라인 범위와 이전/변경 코드를
              구분하며, 누르면 해당 위치로 이동합니다. 파일 전체 근거에는 line 번호를 만들지
              않습니다. 근거 위치가 현재 revision에 없으면 링크가 비활성화됩니다. 기존 메시지는
              저장된 근거만 표시하고, 여러 근거를 선택하는 동작은 새 답변부터 적용됩니다. 모델이
              근거를 반환하지 않으면 임의로 링크를 붙이지 않습니다.
            </p>
          </section>

          <section className="guide-section" id="review-memory">
            <h2>Memory와 GitHub PR 대화 관리</h2>
            <p>
              PR을 열고 하단 Memory 탭을 선택하세요. Repository Memory는 현재 분석에 고정된 집단
              판단을, 내 Memory는 본인의 후보와 활성 항목을 보여줍니다. 현재 코드와 보고서의 근거를
              먼저 확인하고 집단 메모리, 개인 메모리 순으로 과거 판단을 참고합니다.
            </p>
            <h3>PR 대화에서 메모리 저장하기</h3>
            <ol className="guide-steps">
              <li>
                PR 대화에서 수집된 일반 댓글, review 본문과 inline comment를 확인합니다. 작성자,
                본문과 제공된 코드 위치를 읽고 원본 링크에서 GitHub 대화의 맥락을 확인하세요.
              </li>
              <li>
                이후 리뷰에 참고할 내용의 Memory 후보를 누릅니다. 해당 사용자의 원천 상태가 ‘후보로
                저장됨’으로 바뀌고 내 Memory에 개인 후보가 추가됩니다.
              </li>
              <li>
                내 Memory에서 후보 내용을 확인한 뒤 적용 또는 제외를 선택합니다. 활성 항목이 더 이상
                유효하지 않으면 폐기합니다.
              </li>
              <li>
                저장하지 않은 원천은 무시 또는 다시 표시로 관리합니다. 이 상태는 사용자별이며 다른
                사람의 목록이나 GitHub 원문에는 영향을 주지 않습니다.
              </li>
            </ol>
            <p>
              대화는 open PR polling 시 수집됩니다. 봇 메시지도 원천에는 보존하지만 자동으로
              메모리를 활성화하지 않습니다. GitHub에서 본문이 수정되어도 후보가 참조한 저장 당시
              원문 버전은 유지됩니다. 현재 Review와 Chat 영역에서는 finding과 본인의 완료된 Chat
              메시지를 같은 방식으로 후보로 저장할 수 있습니다.
            </p>
            <h3>집단 메모리 승인과 분석 반영</h3>
            <p>
              같은 repository와 검토 주제에서 서로 다른 사용자 두 명 이상이 개인 메모리를 승인하면
              집단 후보를 만듭니다. 관리자는 관리 → Repository Memory에서 repository를 선택하고
              내용·기여 수·충돌 수를 검토한 뒤 활성화 또는 기각합니다. 활성화된 공용 판단은 같은
              화면에서 폐기할 수 있습니다.
            </p>
            <p>
              새 메모리를 분석에 반영하려면 Review workspace를 새로고침하세요. Polling 분석은 집단
              메모리를 사용하고 수동 분석은 요청자의 개인 메모리도 참고합니다. 완료된 보고서와 당시
              고정된 메모리는 변경되지 않습니다. Chat의 새 답변에는 현재 관련 개인 메모리를 추가로
              참고할 수 있습니다. 개인화 분석은 공용 PR 댓글로 게시하지 않습니다.
            </p>
          </section>

          <section className="guide-section" id="code-navigation">
            <h2>파일 tree와 코드 위치로 이동하기</h2>
            <p>
              Files는 모든 폴더를 펼친 상태로 시작하며 폴더를 눌러 접거나 펼칠 수 있습니다. 각 줄
              오른쪽의 초록색 +와 빨간색 −는 추가·삭제 line 수입니다. 폴더에는 하위 파일의 합계를
              표시하며 알 수 없는 수치는 —로 표시합니다. 방향키로 이동·접기·펼치기, Enter로 파일
              선택이 가능합니다.
            </p>
            <p>
              Code에는 현재 파일의 comment 아이콘과 설명이 처음부터 표시됩니다. Summary의 파일별
              요약 block이나 Comments block의 본문·여백을 클릭하면 해당 파일과 line으로 이동합니다.
              텍스트를 드래그해 선택하거나 링크·접기 control을 사용하면 이동하지 않습니다.
              Keyboard에서는 기존 파일 경로·제목·‘코드에서 보기’ 버튼을 사용하세요. 선택한 범위의
              시작 line만 강조하며 모든 줄에 테두리를 반복하지 않습니다. 긴 inline comment는 읽기
              좋은 최대 너비로 표시합니다. P0 Praise는 좋은 변경, P1 Info는 선택적 개선, P2
              Warning은 merge 전 확인할 위험, P3 Critical은 치명적 문제입니다. ‘코드 위치 확인’은
              diff에 해당 line이 있다는 뜻이며 문제의 재현을 보장하지 않습니다. 파일 전체에 대한
              comment나 diff 밖 line은 별도로 안내하고 다른 line에 붙이지 않습니다.
            </p>
          </section>

          <section className="guide-section" id="troubleshooting">
            <div className="guide-section-heading">
              <Wrench size={19} />
              <div>
                <p className="eyebrow">Operations</p>
                <h2>문제 해결</h2>
              </div>
            </div>
            <dl className="guide-troubleshooting">
              <div>
                <dt>
                  <code>401</code> Unauthorized
                </dt>
                <dd>
                  Token 오입력, revoke 또는 만료를 확인하고 같은 credential label로 새 token을
                  등록한 뒤 다시 테스트합니다.
                </dd>
              </div>
              <div>
                <dt>
                  <code>403</code> Forbidden
                </dt>
                <dd>
                  Fine-grained PAT의 organization 승인 상태, repository 선택, PAT 정책과 계정의
                  repository 접근 권한을 확인합니다. Polling은 성공하지만 PR 게시만 실패하면{' '}
                  <code>Pull requests: Read and write</code>인지 확인합니다.
                </dd>
              </div>
              <div>
                <dt>
                  <code>404</code> Repository
                </dt>
                <dd>
                  Owner/repository 철자와 token의 대상 repository를 확인합니다. GHES는 권한이 없을
                  때도 404를 반환할 수 있습니다.
                </dd>
              </div>
              <div>
                <dt>Poll은 성공, 분석 fetch 실패</dt>
                <dd>
                  <code>Contents: read</code>, Web base URL, Worker에서 GHES HTTPS/TLS 접근 가능
                  여부를 확인합니다.
                </dd>
              </div>
              <div>
                <dt>TLS certificate 오류</dt>
                <dd>
                  사내 CA bundle이 Server와 Worker container trust store에 모두 연결되었는지
                  확인합니다.
                </dd>
              </div>
              <div>
                <dt>
                  <code>502 CHAT_MODEL_FAILED</code>
                </dt>
                <dd>
                  관리 화면에서 ChatGPT account 연결, model ID, token 만료와 Pod의 outbound/TLS를
                  확인합니다.
                </dd>
              </div>
            </dl>
          </section>

          <section className="guide-section" id="security">
            <div className="guide-section-heading">
              <ShieldCheck size={19} />
              <div>
                <p className="eyebrow">Checklist</p>
                <h2>Credential 보안 점검</h2>
              </div>
            </div>
            <ul className="guide-checklist">
              <li>
                Token을 Git repository, 문서, ticket, messenger 또는 shell history에 남기지
                않습니다.
              </li>
              <li>
                공용 계정이나 개인 관리자 계정 대신 용도가 제한된 service account를 사용합니다.
              </li>
              <li>
                대상 repository만 선택하고 <code>Metadata</code>와 <code>Contents</code>는
                Read-only,
                <code>Pull requests</code>만 Read and write로 설정합니다.
              </li>
              <li>노출이 의심되면 GHES에서 즉시 revoke한 뒤 새 token을 같은 label로 등록합니다.</li>
              <li>
                연결 목록에는 fingerprint 일부만 표시되는지 확인하고 access token 원문을 공유하지
                않습니다.
              </li>
            </ul>
          </section>

          <footer className="guide-footer">
            <a href="/">
              Pull request 목록으로 돌아가기 <ArrowRight size={14} />
            </a>
            {user?.role === 'administrator' ? (
              <a href="/admin?tab=github">
                GHES 관리 열기 <ArrowRight size={14} />
              </a>
            ) : null}
          </footer>
        </main>
      </div>
    </div>
  );
}
