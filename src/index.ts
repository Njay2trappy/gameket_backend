import "dotenv/config";
import http from "http";
import express from "express";
import cors from "cors";
import { ApolloServer } from "@apollo/server";
import { ApolloServerPluginDrainHttpServer } from "@apollo/server/plugin/drainHttpServer";
import { expressMiddleware } from "@as-integrations/express5";
import jwt from "jsonwebtoken";
import { typeDefs } from "./schema.js";
import { resolvers } from "./resolvers.js";
import { connectDB, closeDB, getDB, getWalletsDB } from "./db.js";
import type { Account, User } from "./types.js";
import depositRouter from "./rest/deposit.js";
import { startCronJobs } from "./cron.js";

const PORT = Number(process.env.PORT) || 4000;
const IS_PROD = process.env.NODE_ENV === "production";

export interface Context {
  user: { userId: string; email: string; role?: "admin"; isSuspended?: boolean } | null;
  authError: string | null;
}

async function main() {
  await connectDB();

  const app = express();
  const httpServer = http.createServer(app);

  const server = new ApolloServer<Context>({
    typeDefs,
    resolvers,
    includeStacktraceInErrorResponses: !IS_PROD,
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
  });

  await server.start();

  // REST API routes (before GraphQL catch-all)
  app.use(express.json());
  app.use(depositRouter);

  app.use(
    "/",
    cors(),
    express.json(),
    expressMiddleware(server, {
      context: async ({ req }) => {
        const adminAuthHeader = req.headers["adminauthorization"];
        const authHeader = req.headers.authorization;
        const adminAuth = Array.isArray(adminAuthHeader) ? adminAuthHeader[0] : (adminAuthHeader || "");
        const auth = Array.isArray(authHeader) ? authHeader[0] : (authHeader || "");

        if (adminAuth) {
          if (!adminAuth.startsWith("Bearer ")) {
            return { user: null, authError: "Invalid AdminAuthorization token format" };
          }

          const token = adminAuth.slice(7);
          try {
            const adminSecret = process.env.ADMIN_JWT_SECRET;
            if (!adminSecret) {
              throw new Error("Server configuration error");
            }

            const adminDecoded = jwt.verify(token, adminSecret) as {
              adminId: string;
              email: string;
              role: "admin";
              tokenVersion: number;
            };

            if (adminDecoded.role !== "admin") {
              return { user: null, authError: "Invalid admin authentication token" };
            }

            const db = getDB();
            const adminDoc = await db.collection("Admin").findOne({ key: "admin" });
            if (!adminDoc || adminDoc.tokenVersion !== adminDecoded.tokenVersion) {
              return { user: null, authError: "Admin session expired. Please login again" };
            }

            const adminUser = await db.collection<User>("users").findOne({
              email: adminDecoded.email.trim().toLowerCase(),
            });

            if (adminUser?.isSuspended) {
              return { user: null, authError: "Account is suspended" };
            }
            if (adminUser && !adminUser.isActive) {
              return { user: null, authError: "Account is deactivated" };
            }

            const resolvedUserId = adminUser?.id ?? adminDecoded.adminId;

            return {
              user: { userId: resolvedUserId, email: adminDecoded.email, role: "admin" as const },
              authError: null,
            };
          } catch (err) {
            if (err instanceof jwt.TokenExpiredError) {
              return { user: null, authError: "Admin authentication token has expired. Please login again" };
            }
            if (err instanceof jwt.JsonWebTokenError) {
              return { user: null, authError: "Invalid admin authentication token" };
            }
            return { user: null, authError: "Admin authentication failed" };
          }
        }

        if (!auth.startsWith("Bearer ")) {
          return { user: null, authError: "No authentication token provided" };
        }

        const token = auth.slice(7);
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
            userId: string;
            email: string;
            tokenVersion: number;
          };

          const db = getDB();
          const account = await db
            .collection<Account>("accounts")
            .findOne({ userId: decoded.userId });

          if (!account || account.tokenVersion !== decoded.tokenVersion) {
            return { user: null, authError: "Session expired. Please login again" };
          }

          const user = await db.collection<User>("users").findOne({ id: decoded.userId });
          if (!user) {
            return { user: null, authError: "Authentication failed" };
          }
          if (!user.isActive && !user.isSuspended) {
            return { user: null, authError: "Account is deactivated" };
          }

          return { user: { userId: decoded.userId, email: decoded.email, isSuspended: user.isSuspended ?? false }, authError: null };
        } catch (err) {
          if (err instanceof jwt.TokenExpiredError) {
            return { user: null, authError: "Authentication token has expired. Please login again" };
          }
          if (err instanceof jwt.JsonWebTokenError) {
            return { user: null, authError: "Invalid authentication token" };
          }
          return { user: null, authError: "Authentication failed" };
        }
      },
    })
  );

  httpServer.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}/`);
    startCronJobs();
  });

  const shutdown = async () => {
    console.log("\nShutting down...");
    await server.stop();
    await closeDB();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(console.error);
