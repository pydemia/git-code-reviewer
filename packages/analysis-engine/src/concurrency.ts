/** 입력 순서를 보존하고 실패 시 새 작업을 멈춘 뒤 실행 중인 작업까지 회수한다. */
export async function mapConcurrent<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  operation: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw Error('Analysis concurrency must be an integer between 1 and 4');
  const results = new Array<Output>(inputs.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
      while (!failed && next < inputs.length) {
        const index = next++;
        try {
          results[index] = await operation(inputs[index]!, index);
        } catch (error) {
          if (!failed) failure = error;
          failed = true;
        }
      }
    }),
  );
  if (failed) throw failure;
  return results;
}
