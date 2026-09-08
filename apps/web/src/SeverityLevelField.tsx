import {
  reviewSeverityLevelSchema,
  reviewSeverityLevels,
  type ReviewSeverityLevel,
} from '@gcr/contracts';

export function SeverityLevelField({
  value,
  disabled,
  onChange,
}: {
  value: ReviewSeverityLevel;
  disabled: boolean;
  onChange: (value: ReviewSeverityLevel) => void;
}) {
  return (
    <fieldset className="severity-level-field" disabled={disabled} aria-describedby="severity-help">
      <legend>분석 수준 · Severity Level</legend>
      <p id="severity-help">
        새로 queue에 등록되는 분석에 적용됩니다. Model·effort 설정과 기존 report는 바뀌지 않습니다.
      </p>
      <div className="severity-level-options">
        {reviewSeverityLevelSchema.options.map((level) => (
          <label
            className={`severity-level-option${value === level ? ' selected' : ''}`}
            key={level}
          >
            <input
              type="radio"
              name="severity-level"
              value={level}
              checked={value === level}
              onChange={() => onChange(level)}
            />
            <span>
              <strong>
                {level}
                {level === 'moderate' ? ' · 기본값' : ''}
              </strong>
              <span>{reviewSeverityLevels[level].description}</span>
              <small>{reviewSeverityLevels[level].scope}</small>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
