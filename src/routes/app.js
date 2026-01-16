import express from 'express';

const router = express.Router();

// Deep link OAuth callback
router.get('/oauth-callback', (req, res) => {
  const { platform, success, error } = req.query;
  const deepLink = `rexstream://oauth-callback?platform=${platform || 'unknown'}&success=${success || 'false'}${error ? '&error=' + error : ''}`;

  res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Redirecting to RexStream...</title>
    <style>
        body { font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
        .container { text-align: center; background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.1); max-width: 400px; }
        .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #667eea; border-radius: 50%; width: 50px; height: 50px; animation: spin 1s linear infinite; margin: 0 auto 1rem; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        h1 { color: #333; margin-bottom: 0.5rem; }
        p { color: #666; }
        .btn { display: inline-block; margin-top: 1rem; padding: 0.75rem 1.5rem; background: #667eea; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; }
    </style>
</head>
<body>
    <div class="container">
        <div class="spinner"></div>
        <h1>Opening RexStream App...</h1>
        <p id="message">Redirecting you to the app...</p>
        <a href="${deepLink}" id="manualLink" class="btn" style="display:none;">Open App Manually</a>
    </div>
    <script>
        setTimeout(() => {
            window.location.href = '${deepLink}';
            setTimeout(() => {
                document.getElementById('message').textContent = 'App not installed?';
                document.getElementById('manualLink').style.display = 'inline-block';
            }, 2000);
        }, 500);
    </script>
</body>
</html>
  `);
});

export default router;
