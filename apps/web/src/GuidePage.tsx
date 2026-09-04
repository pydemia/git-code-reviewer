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

const githubPatDocs =
  'https://docs.github.com/en/enterprise-server@3.21/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens';
const githubApiAuthDocs =
  'https://docs.github.com/en/enterprise-server@3.21/rest/authentication/authenticating-to-the-rest-api';
const githubCredentialSecurityDocs =
  'https://docs.github.com/en/enterprise-server@3.21/rest/authentication/keeping-your-api-credentials-secure';

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
            <strong>사용 가이드</strong>
          </div>
          <a href="#start">시작하기</a>
          <a href="#ghes-credential">GHES credential</a>
          <a href="#register-repository">Repository 등록</a>
          <a href="#review-flow">Review와 Chat</a>
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
              계정에는 review 대상 repository의 Read 권한만 부여하십시오. 현재 registry가 받는
              credential은 GHES Personal Access Token(PAT)입니다.
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
                    <td>Read-only</td>
                    <td>Open PR polling과 base/head SHA 확인</td>
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
              만료·회전 주기를 적용하십시오. Admin, write, workflow scope는 필요하지 않습니다.
            </p>

            <h3>관리 화면 입력값</h3>
            <dl className="guide-fields">
              <div>
                <dt>연결 이름</dt>
                <dd>
                  사람이 GHES instance를 식별하는 이름입니다. 예: <code>사내 GHES 운영계</code>
                </dd>
              </div>
              <div>
                <dt>API base URL</dt>
                <dd>
                  <code>https://GHES_HOST/api/v3/</code> 형식입니다.
                </dd>
              </div>
              <div>
                <dt>Web base URL</dt>
                <dd>
                  <code>https://GHES_HOST/</code> 형식입니다. Git fetch와 원본 link에 사용합니다.
                </dd>
              </div>
              <div>
                <dt>Credential label</dt>
                <dd>
                  이 서비스 내부의 관리용 식별자입니다. secret이나 GHES username이 아닙니다. 예:{' '}
                  <code>ghes-reviewer-readonly</code>. 같은 GHES와 같은 label로 다시 등록하면 기존
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
              <li>GHES 연결, tenant, owner와 repository 이름, polling interval을 입력합니다.</li>
              <li>
                일반 사용자가 필요하면 사용자 권한을 선택합니다. 미선택 시 관리자만 볼 수 있습니다.
              </li>
              <li>
                Repository 등록 후 Poll now를 실행해 open PR과 마지막 polling 결과를 확인합니다.
              </li>
              <li>
                PR에서 분석을 시작해 Worker가 commit을 fetch하고 report를 생성하는지 확인합니다.
              </li>
            </ol>
            <p className="guide-note">
              이 연결은 inbound webhook을 열지 않습니다. Server가 지정한 interval에 GHES로 outbound
              요청을 보내고, 변경이 있을 때 Worker가 필요한 commit만 가져옵니다.
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
                <span>Tenant를 선택하고 분석할 PR을 엽니다.</span>
              </div>
              <ArrowRight size={17} />
              <div>
                <strong>2. Findings</strong>
                <span>LNB에서 finding을 고르고 diff와 evidence를 확인합니다.</span>
              </div>
              <ArrowRight size={17} />
              <div>
                <strong>3. Chat</strong>
                <span>
                  오른쪽에서 account, model, effort를 선택하고 현재 revision을 질문합니다.
                </span>
              </div>
            </div>
            <p>
              하단 FNB에서 Evidence, Git graph, Impact, Tests를 전환할 수 있습니다. Finding을
              선택하면 diff anchor, evidence와 Chat scope가 같은 analysis revision에 맞춰집니다.
              Chat account가 보이지 않으면 시스템 관리자에게 account assignment와 model policy를
              확인해 달라고 요청하십시오.
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
                  repository Read 권한을 확인합니다.
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
              <li>대상 repository와 Read permission만 선택하고 만료일과 교체 담당자를 정합니다.</li>
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
