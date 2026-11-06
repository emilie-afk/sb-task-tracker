// Local preview: serves the built client (dist/) and the same API handler as the Netlify function.
//   npm run build && DATABASE_URL=... APP_BASE_URL=http://localhost:8888 APP_SECRET=... npm run dev
// LOCAL_DEV_LOGIN=1 adds /dev/login?user=<uuid> for local testing with fictional accounts. It refuses to run on
// Netlify or in production, and the deployed function has no such route.
import { createPreviewServer } from "./preview-server";

const port = Number(process.env.PORT ?? 8888);
createPreviewServer({ port, devLogin: process.env.LOCAL_DEV_LOGIN === "1" }).listen(port, () => console.log(`http://localhost:${port}`));
