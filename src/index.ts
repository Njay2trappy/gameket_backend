import "dotenv/config";
import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import jwt from "jsonwebtoken";
import { typeDefs } from "./schema.js";
import { resolvers } from "./resolvers.js";
import { connectDB, closeDB, getDB } from "./db.js";
import type { Account } from "./types.js";

const PORT = Number(process.env.PORT) || 4000;
const IS_PROD = process.env.NODE_ENV === "production";

export interface Context {
  user: { userId: string; email: string } | null;
}

async function main() {
  await connectDB();

  const server = new ApolloServer({
    typeDefs,
    resolvers,
    includeStacktraceInErrorResponses: !IS_PROD,
  });

  const { url } = await startStandaloneServer(server, {
    listen: { port: PORT },
    context: async ({ req }) => {
      const auth = req.headers.authorization || "";
      if (auth.startsWith("Bearer ")) {
        const token = auth.slice(7);
        try {
          const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
            userId: string;
            email: string;
            tokenVersion: number;
          };

          // Verify tokenVersion matches the DB to enforce single session
          const db = getDB();
          const account = await db
            .collection<Account>("accounts")
            .findOne({ userId: decoded.userId });

          if (!account || account.tokenVersion !== decoded.tokenVersion) {
            return { user: null };
          }

          return { user: { userId: decoded.userId, email: decoded.email } };
        } catch {
          return { user: null };
        }
      }
      return { user: null };
    },
  });

  console.log(`🚀 Server running at ${url}`);

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
