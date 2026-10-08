/**
 * Đăng nhập bằng Firebase Auth (email/mật khẩu + Google).
 * Sau requireAuth(): window.AUTH_USER = {uid, email, name}; window.TENANT = uid
 * (mỗi tài khoản là một cửa hàng; server tính tenant từ uid trong ID token).
 */
if (!FIREBASE_CONFIG.apiKey) console.error('Thiếu cấu hình Firebase: điền assets/js/firebase-config.js');
firebase.initializeApp(FIREBASE_CONFIG);
const fbAuth = firebase.auth();

const toAppUser = u => ({ uid: u.uid, email: u.email || '', name: u.displayName || u.email || '' });
const authReady = new Promise(resolve => { const off = fbAuth.onAuthStateChanged(u => { off(); resolve(u); }); });

async function requireAuth() {
  const user = await authReady;
  if (!user) return redirectToLogin();
  window.AUTH_USER = toAppUser(user);
  window.TENANT = user.uid;
}

async function getIdToken() {
  if (!fbAuth.currentUser) throw new Error('Phiên đăng nhập đã hết hạn.');
  return fbAuth.currentUser.getIdToken(); // SDK tự làm mới token khi gần hết hạn
}

const AUTH_ERRORS = {
  'auth/invalid-credential': 'Sai email hoặc mật khẩu.',
  'auth/wrong-password': 'Sai email hoặc mật khẩu.',
  'auth/user-not-found': 'Sai email hoặc mật khẩu.',
  'auth/email-already-in-use': 'Email này đã có tài khoản.',
  'auth/weak-password': 'Mật khẩu cần ít nhất 6 ký tự.',
  'auth/invalid-email': 'Email không hợp lệ.',
  'auth/too-many-requests': 'Thử quá nhiều lần, hãy đợi một lúc.',
  'auth/popup-closed-by-user': 'Bạn đã đóng cửa sổ đăng nhập Google.',
  'auth/unauthorized-domain': 'Tên miền này chưa được thêm vào Authorized domains của Firebase.',
};
const authError = error => new Error(AUTH_ERRORS[error.code] || error.message);

async function loginWithPassword(email, password) {
  try { await fbAuth.signInWithEmailAndPassword(email, password); } catch (e) { throw authError(e); }
  location.href = 'overview.html';
}
async function registerWithPassword(email, password) {
  try { await fbAuth.createUserWithEmailAndPassword(email, password); } catch (e) { throw authError(e); }
  location.href = 'overview.html';
}
async function loginWithGoogle() {
  try { await fbAuth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); } catch (e) { throw authError(e); }
  location.href = 'overview.html';
}
async function resetPassword(email) {
  try { await fbAuth.sendPasswordResetEmail(email); } catch (e) { throw authError(e); }
}

async function logout() { await fbAuth.signOut(); redirectToLogin(); }
function redirectToLogin() { location.href = 'index.html'; }
