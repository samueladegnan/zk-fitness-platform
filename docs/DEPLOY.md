# Deploy the optional API

GitHub Pages hosts the static frontend and project documentation. Account mode and encrypted sync need the Node.js API and PostgreSQL database. Local mode works without either service.

The files in this repository describe a deployable path. They do not establish uptime, backups, monitoring, incident response, or other operational guarantees.

## Required configuration

The API needs these environment variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` or `DB_*` variables | PostgreSQL connection details |
| `DB_SSL_REJECT_UNAUTHORIZED` | Set to `false` for Render's managed PostgreSQL certificate |
| `JWT_SECRET` | Secret used to sign session cookies |
| `CLIENT_ORIGIN` | The frontend origin allowed to make state-changing requests |

Generate a local or hosted secret with:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Do not commit the result.

## Local Docker stack

```bash
export JWT_SECRET=$(node -e 'console.log(require("crypto").randomBytes(64).toString("hex"))')
export CLIENT_ORIGIN="http://localhost:3001"
docker compose up --build
```

The Compose stack starts PostgreSQL, waits for its health check, runs migrations, and starts the API at `http://localhost:3000`. The local Compose API runs in development mode so its HTTP-only cookie can be used by the HTTP frontend at `http://localhost:3001`. In another terminal, serve the frontend:

```bash
npm run dev:client
```

Check the API and database connection at:

```text
http://localhost:3000/api/health
```

Stop the stack with:

```bash
docker compose down
```

## Migration safety

The migration does not silently delete legacy users or sync records. If an existing database contains rows from the pre-PQC schema, migration stops with an operator-readable error. Choose and document an explicit export, reset, or application-specific migration plan before retrying. Do not bypass that failure by deleting production data from the migration script.

## Render and managed PostgreSQL

`render.yaml` provides a Render Blueprint for the backend and its PostgreSQL database. The service is pinned to `main`, waits for CI checks, runs migrations during its production startup command, and exposes `/api/health` as its health check. Running the migration at startup keeps the Blueprint compatible with Render's free web service plan, which does not provide pre-deploy commands.

Render's managed PostgreSQL endpoint uses a self-signed certificate. The Blueprint keeps the connection encrypted with TLS and sets `DB_SSL_REJECT_UNAUTHORIZED=false` because Render does not provide a public CA chain for this connection. The database URL's SSL query parameters are removed before `pg` receives it so this explicit TLS setting is not overwritten.

1. Create a Render Blueprint from this repository and the `main` branch.
2. Accept the generated `JWT_SECRET` and the managed Postgres connection exposed by the Blueprint.
3. Confirm `CLIENT_ORIGIN` is `https://samueladegnan.github.io`.
4. Confirm `DB_SSL_REJECT_UNAUTHORIZED` is `false` for the Render-managed database connection.
5. Confirm the service uses `npm run start:prod`, which applies the migration before starting the API.
6. Use the service health check at `/api/health` after deployment.
7. Confirm the service URL and cookie behavior before pointing a hosted frontend at it.

The default Pages build uses `https://zk-fitness-api.onrender.com/api`. Set the `ZK_API_BASE` Actions repository variable if the service uses a different public URL.

For a GitHub Pages deployment, `CLIENT_ORIGIN` should be the origin only, such as:

```text
https://samueladegnan.github.io
```

The repository path does not belong in `CLIENT_ORIGIN`.

## Point GitHub Pages at the API

The Pages workflow injects the API base URL into the generated `frontend/config.js` file.

1. Open the repository settings in GitHub.
2. Add an Actions repository variable named `ZK_API_BASE`.
3. Set it to the API base URL, such as:

   ```text
   https://your-api-host.example/api
   ```

4. Run the Pages workflow again or push a change to `main`.

If the variable is not set, the generated frontend uses the default Render service URL above.

## Cookies and cross-origin requests

When the frontend and API have different origins, the API uses `SameSite=None` and `Secure` cookies. Both sites must use HTTPS outside local development. The API also checks the configured origin on state-changing requests.

## Deployment limitations

This setup does not include a backup policy, a high-availability topology, key rotation, password recovery, conflict resolution, a monitoring service, or an incident response process. Treat the deployment as a portfolio demonstration until those concerns are designed and operated deliberately.
