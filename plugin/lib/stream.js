/**
 * 流中转：不缓冲、不改内容，只旁路观察 usage / finish 并保证收尾幂等。
 *
 * 设计要点
 *   - 透传：每个 chunk 原样向下游 yield，Guard 不改变模型输出。
 *   - 保留 partial：上游中断时已 yield 的内容**不会**被撤销（SPEC 第 21 节）。
 *   - 不自动重放：任何异常都只做收尾与上报，绝不重新 dispatch（SPEC 第 4、21 节）。
 *   - 收尾只跑一次：无论正常结束、异常、还是消费者提前 return，
 *     都通过 finally + settled 标志保证 settle 恰好执行一次。
 *
 * @module lib/stream
 */

/**
 * 判断 chunk 是否携带 usage。
 * @param {unknown} chunk - 流块。
 * @returns {boolean} 是 usage 块为 true。
 */
export function isUsageChunk(chunk) {
  return typeof chunk === 'object' && chunk !== null && chunk.type === 'usage';
}

/**
 * 判断 chunk 是否携带 finish。
 * @param {unknown} chunk - 流块。
 * @returns {boolean} 是 finish 块为 true。
 */
export function isFinishChunk(chunk) {
  return typeof chunk === 'object' && chunk !== null && chunk.type === 'finish';
}

/**
 * 包装下游流，观察 usage/finish 并在所有出口完成一次收尾。
 *
 * @param {AsyncIterable<object>} stream - 下游流。
 * @param {object} context - 上下文。
 * @param {object} context.guard - Guard 实例（需有 settle 方法）。
 * @param {string} context.attemptId - attempt ID。
 * @param {object} context.record - 请求记录。
 * @returns {AsyncIterable<object>} 包装后的流。
 */
export function createStreamRelay(stream, context) {
  const { guard } = context;

  async function* relay() {
    let settled = false;
    let gotUsage = false;
    let gotFinish = false;
    let usage;
    let finishKind;
    let errorCode;

    const settleOnce = async () => {
      if (settled) return;
      settled = true;
      try {
        await guard.settle(context, { usage, gotUsage, gotFinish, errorCode, finishKind });
      } catch {
        // 收尾失败不得吞掉模型输出或原始异常
      }
    };

    try {
      for await (const chunk of stream) {
        if (isUsageChunk(chunk)) {
          gotUsage = true;
          // 只采纳第一个 usage：同一 attempt 的 usage 只能记账一次（SPEC 第 24 节）
          if (usage === undefined) usage = chunk.usage;
        } else if (isFinishChunk(chunk)) {
          gotFinish = true;
          finishKind = chunk.reason?.kind;
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') {
            errorCode = chunk.reason?.failure?.code;
            if (context.record.state === 'dispatching' || context.record.state === 'streaming') {
              context.record.state = chunk.reason.kind === 'aborted' ? 'partial' : 'unknown';
            }
          }
        }
        // 透传，绝不改写
        yield chunk;
      }
    } catch (error) {
      // 已 dispatch 后出错：不重放，保留 partial（SPEC 第 21 节）
      errorCode = error?.code;
      if (context.record.state === 'dispatching' || context.record.state === 'streaming') {
        context.record.state = 'partial';
      }
      await settleOnce();
      throw error;
    } finally {
      await settleOnce();
    }
  }

  return relay();
}
