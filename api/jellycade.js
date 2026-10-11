export default async function handler(req, res) {
  const requestedPath = Array.isArray(req.query.path)
    ? req.query.path.join("/")
    : (req.query.path || "/en");

  // Only allow requests to Jellycade's own domain.
  const target = new URL(
    requestedPath.startsWith("/") ? requestedPath : `/${requestedPath}`,
    "https://jellycade.com"
  );

  if (target.hostname !== "jellycade.com") {
    return res.status(403).send("Only Jellycade is allowed.");
  }

  try {
    const response = await fetch(target, {
      headers: {
        "User-Agent": req.headers["user-agent"] || "JellycadeHub"
      },
      redirect: "follow"
    });

    const contentType = response.headers.get("content-type") || "text/plain";
    const body = await response.arrayBuffer();

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-store");
    return res.status(response.status).send(Buffer.from(body));
  } catch {
    return res.status(502).send("Jellycade could not be reached.");
  }
}
