
export default async function handler(req, res) {
  const allowedOrigin = "https://jellycade-hub.vercel.app";
  const origin = req.headers.origin;

  if (origin && origin !== allowedOrigin) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, Accept"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  // This endpoint is a diagnostic placeholder.
  // Do not forward authentication requests until the game's
  // supported server connection and required headers are verified.
  return res.status(501).json({
    error: "Multiplayer proxy is not configured yet",
    message: "The game's request routing must be identified first."
  });
}
