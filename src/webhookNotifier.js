import { emitWebhookEvent, processDueWebhooks } from "./webhooks.js";

/**
 * Trả về hàm notify([[type, data], ...]) cho một tenant. Gửi webhook chạy nền (waitUntil) để không làm chậm phản hồi;
 * khi không có waitUntil (test) thì chờ xong. Lỗi webhook không bao giờ làm hỏng yêu cầu chính.
 */
export function createNotifier({ repository, tenant, waitUntil }) {
  return async (events) => {
    const work = (async () => {
      try {
        for (const [type, data] of events) await emitWebhookEvent({ repository, tenant, type, data });
        await processDueWebhooks({ repository, tenant });
      } catch (error) { console.error("webhook dispatch failed", error); }
    })();
    if (waitUntil) waitUntil(work); else await work;
  };
}
