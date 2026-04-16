import { GraphQLError } from "graphql";
import { getDB } from "../../db.js";
import { getWalletsDB } from "../../db.js";
import type { User, Balance, Account } from "../../types.js";
import type { Context } from "../../index.js";

export const usersQueries = {
  getUserDetails: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError("Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;

    const db = getDB();
    const walletsDB = getWalletsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });

    if (!user) {
      return {
        code: 404,
        success: false,
        message: "User not found",
        user: null,
      };
    }

    const account = await db.collection<Account>("accounts").findOne({ userId });

    const balance = await walletsDB
      .collection<Balance>("Balances")
      .findOne({ userId });

    const wallet = balance
      ? {
          availableBalance: balance.availableBalance,
          suspendedBalance: balance.suspendedBalance,
          methods: balance.methods,
        }
      : null;

    return {
      code: 200,
      success: true,
      message: "User details retrieved successfully",
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        country: user.country,
        isActive: user.isActive,
        isVerified: user.isVerified,
        isPremium: user.isPremium,
        twoFactorAuth: account?.twoFactorAuth ?? false,
        rank: user.rank,
        registered: user.registered,
        isStore: user.isStore,
        avatar: user.avatar,
        wallet,
      },
    };
  },
};

export const usersMutations = {};
