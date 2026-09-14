import type { criterionSourceSchema } from '@gcr/contracts';
import type { z } from 'zod';
import { CriterionSourceEvidence } from './CriterionSourceEvidence.tsx';

export function CriterionSourcePicker({
  sources,
  selected,
  onToggle,
}: {
  sources: z.infer<typeof criterionSourceSchema>[];
  selected: string[];
  onToggle: (key: string, checked: boolean) => void;
}) {
  return (
    <details>
      <summary>PR 논의·코드 변경·집단 메모리 선택</summary>
      <p>
        코드 변경은 새로 수집한 snapshot의 텍스트 diff입니다. 바이너리·12,000자 초과 diff와 기존
        snapshot은 출처 목록에 포함되지 않습니다.
      </p>
      {sources.length ? (
        sources.map((source) => {
          const key = `${source.kind}:${source.id}`;
          return (
            <div className="criteria-source-option" key={key}>
              <label className="criteria-source-choice">
                <input
                  type="checkbox"
                  checked={selected.includes(key)}
                  onChange={(event) => onToggle(key, event.target.checked)}
                />
                <span>
                  {source.label}
                  <small>{source.content.slice(0, 240)}</small>
                </span>
              </label>
              <CriterionSourceEvidence source={source} />
              <details>
                <summary>{source.codeChange ? '변경 diff 확인' : '원문 확인'}</summary>
                <pre>{source.content}</pre>
              </details>
            </div>
          );
        })
      ) : (
        <p>연결할 수 있는 출처가 없습니다.</p>
      )}
    </details>
  );
}
