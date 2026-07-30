# Deploy the Backend

GitHub Pages hosts only the static frontend. To enable authentication and encrypted sync, deploy the Node.js/Express backend with a Postgres database.

| Component | Service | Plan |
|---|---|---|
| App hosting | [Render](https://render.com) web service | Free |
| Database | [Neon](https://neon.tech) Postgres | Free |

Free Render web services spin down after 15 minutes of inactivity. The first request after a cold start may take 30–60 seconds.

## Step 1: Create the Neon database

1. Sign in to [Neon](https://neon.tech) and create a new project.
2. Create a database named `fitness_db`.
3. Copy the **connection string**. It has the form:
   ```text
   postgresql://<user>:<password>@<host>.neon.tech/fitness_db?sslmode=require
   ```
4. Keep the `?sslmode=require` suffix. Store the connection string for Step 2.

## Step 2: Deploy the backend to Render

This repository includes `render.yaml`, a Render Blueprint.

1. Push the repository to GitHub.
2. In the Render dashboard, select **New +** > **Blueprint**.
3. Connect the GitHub repository and choose the `main` branch.
4. Render reads `render.yaml` and creates a web service named `zk-fitness-api`.
5. Open the service's **Environment** tab and add the following variables:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | Neon connection string from Step 1 |
   | `JWT_SECRET` | Strong random secret (see below) |
   | `CLIENT_ORIGIN` | Your GitHub Pages origin, e.g. `https://<username>.github.io` |

   Generate a secret with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
   ```

   Paste the output into `JWT_SECRET`. Do not commit it.

6. (Optional) Set `LOG_LEVEL` to control backend logging. The backend uses Pino for structured JSON logs. In production it defaults to `info`; set it to `debug` for more detail, or `warn` for quieter output.

7. Redeploy if necessary. The `start:prod` command runs database migrations automatically, and the `/api/health` endpoint verifies that the API and database are both reachable.

After deployment, the backend is available at the service URL Render provides. With the default service name in `render.yaml`, the URL is:

```text
https://zk-fitness-api.onrender.com/api
```

## Step 3: Point the frontend to the backend

The GitHub Pages workflow injects the backend URL into `frontend/config.js` at deploy time.

1. In GitHub, go to **Settings > Secrets and variables > Actions > Variables**.
2. Add a repository variable named `ZK_API_BASE`.
3. Set its value to the deployed backend root URL, for example:
   ```text
   https://zk-fitness-api.onrender.com/api
   ```
4. Redeploy GitHub Pages. Pushes to `main` trigger this automatically.

For local development, leave `ZK_API_BASE` unset. The app falls back to `http://localhost:3000/api`.

## Step 4: Configure CORS and cookies

This step explains what the `CLIENT_ORIGIN` environment variable from Step 2 does. You do **not** set it in a different place.

The backend uses `CLIENT_ORIGIN` to validate incoming requests and to decide how to set cookies. It must be the GitHub Pages origin (the host only, not the full repository path).

| Setting | Example value |
|---|---|
| `CLIENT_ORIGIN` | `https://<username>.github.io` |

Because the frontend and backend are on different origins, the backend sets cookies with `SameSite=None; Secure`. Both sites must use HTTPS, which is the default for both Render and GitHub Pages.
