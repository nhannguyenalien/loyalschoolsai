/**
 * Cùng backend với dashboard chính (PocketBase + Worker). Không phải bí mật.
 */
const PB_URL = "https://nhannguyen123-chat.hf.space";
const WORKER_URL = "https://apic.schoolsai.work";

const PB = new PocketBase(PB_URL);
window.PB = PB;
