# Dùng chung: in phần <head> cho các trang có đăng nhập. Cách dùng: . scripts/head.sh; head_html "Tiêu đề"
head_html() { cat <<HTML
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>$1 - Loyal SchoolsAI</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800&display=swap">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/core@1.0.0-beta20/dist/css/tabler.min.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.19.0/dist/tabler-icons.min.css">
  <link rel="stylesheet" href="assets/css/app.css">
  <script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js"></script>
  <script src="assets/js/firebase-config.js"></script>
  <script src="assets/js/ui.js"></script>
  <script src="assets/js/auth.js"></script>
  <script src="assets/js/api.js"></script>
  <script src="assets/js/layout.js"></script>
$2</head>
<body class="layout-fluid">
<div class="page" id="layout"></div>
HTML
}
foot_html() { echo '<script src="https://cdn.jsdelivr.net/npm/@tabler/core@1.0.0-beta20/dist/js/tabler.min.js"></script>
</body>
</html>'; }
