export type DiffFileForTestAnalysis = {
  path: string;
  additions: number | null;
  patch: string;
};

export type AddedTestCase = {
  title: string;
  line: number;
  suite?: string;
  assertionCount: number;
  explanation: string;
};

export type AddedTestFile = {
  path: string;
  additions: number;
  summary: string;
  cases: AddedTestCase[];
  patchAvailable: boolean;
};

type AddedLine = { number: number; content: string };

const testPathPattern =
  /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.py$/i;
const suitePattern = /\b(?:describe|context)\s*\(\s*(['"`])(.+?)\1/;
const javascriptCasePattern =
  /\b(?:it|test)(?:\.(?:only|skip|todo|concurrent|each))*\s*\(\s*(['"`])(.+?)\1/;
const pythonCasePattern = /^\s*(?:async\s+)?def\s+(test_[a-zA-Z0-9_]+)\s*\(/;

export function analyzeAddedTests(files: DiffFileForTestAnalysis[]): AddedTestFile[] {
  return files.filter((file) => testPathPattern.test(file.path)).map(analyzeTestFile);
}

function analyzeTestFile(file: DiffFileForTestAnalysis): AddedTestFile {
  const addedLines = addedPatchLines(file.patch);
  const cases: AddedTestCase[] = [];
  let suite: string | undefined;
  let activeCase: { title: string; line: number; suite?: string; body: string[] } | undefined;

  const completeCase = () => {
    if (!activeCase) return;
    const assertionCount = activeCase.body.filter(isAssertion).length;
    cases.push({
      title: activeCase.title,
      line: activeCase.line,
      ...(activeCase.suite ? { suite: activeCase.suite } : {}),
      assertionCount,
      explanation: explainCase(activeCase.title, activeCase.body, assertionCount),
    });
  };

  for (const line of addedLines) {
    const suiteMatch = line.content.match(suitePattern);
    if (suiteMatch?.[2]) suite = suiteMatch[2];
    const javascriptMatch = line.content.match(javascriptCasePattern);
    const pythonMatch = line.content.match(pythonCasePattern);
    const title =
      javascriptMatch?.[2] ?? pythonMatch?.[1]?.replace(/^test_/, '').replaceAll('_', ' ');
    if (title) {
      completeCase();
      activeCase = {
        title,
        line: line.number,
        ...(suite ? { suite } : {}),
        body: [line.content],
      };
    } else if (activeCase) {
      activeCase.body.push(line.content);
    }
  }
  completeCase();

  const additions = file.additions ?? addedLines.length;
  const patchAvailable = addedLines.length > 0;
  return {
    path: file.path,
    additions,
    cases,
    patchAvailable,
    summary: summarizeFile(additions, cases, patchAvailable),
  };
}

function addedPatchLines(patch: string): AddedLine[] {
  const added: AddedLine[] = [];
  let headLine = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      headLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith('\\ No newline')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push({ number: headLine, content: line.slice(1) });
      headLine += 1;
      continue;
    }
    if (!line.startsWith('-')) headLine += 1;
  }
  return added;
}

function isAssertion(line: string): boolean {
  return /\bexpect\s*\(|\bassert(?:\s|[A-Z])|\.should\b|\bpytest\.raises\b/.test(line);
}

function explainCase(title: string, body: string[], assertionCount: number): string {
  const source = `${title} ${body.join(' ')}`.toLowerCase();
  let purpose: string;
  if (/concurr|simultaneous|parallel|race|동시/.test(source)) {
    purpose = '동시 요청과 경합 상황에서도 결과가 일관적인지 검증합니다.';
  } else if (/rollback|transaction|commit|트랜잭션/.test(source)) {
    purpose = '트랜잭션 경계에서 성공과 실패가 원자적으로 처리되는지 검증합니다.';
  } else if (/throw|reject|error|invalid|fail|예외|오류|실패/.test(source)) {
    purpose = '오류 입력 또는 실패 경로가 예상대로 처리되는지 검증합니다.';
  } else if (/null|empty|missing|revoked|없|취소/.test(source)) {
    purpose = '값이 없거나 더 이상 유효하지 않은 상태의 반환 결과를 검증합니다.';
  } else {
    purpose = `"${title}" 시나리오의 동작과 반환 결과를 검증합니다.`;
  }
  return assertionCount > 0 ? `${purpose} 기대 조건 ${assertionCount}개를 확인합니다.` : purpose;
}

function summarizeFile(additions: number, cases: AddedTestCase[], patchAvailable: boolean): string {
  if (cases.length > 0) {
    const assertions = cases.reduce((total, testCase) => total + testCase.assertionCount, 0);
    return `${cases.length}개의 test case와 ${assertions}개의 기대 조건이 추가되었습니다.`;
  }
  if (!patchAvailable) {
    return `테스트 파일에 ${additions}줄이 추가되었지만 snapshot diff에 본문이 없습니다.`;
  }
  return `${additions}줄의 테스트 코드가 추가되었지만 지원되는 test case 선언을 찾지 못했습니다.`;
}
