import { randomBytes } from "crypto";
import { GraphQLError } from "graphql";
import { getDB } from "../../db.js";
import { getWalletsDB } from "../../db.js";
import type { User, Balance, Deposit, Transaction } from "../../types.js";
import type { Context } from "../../index.js";

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString("base64");
}

function decodeCursor(cursor: string): number {
  const decoded = Buffer.from(cursor, "base64").toString("utf-8");
  return parseInt(decoded.replace("cursor:", ""), 10);
}

export const walletsQueries = {
  getUserWallets: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const walletsDB = getWalletsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });

    const balance = await walletsDB
      .collection<Balance>("Balances")
      .findOne({ userId });

    if (!balance) {
      return { code: 404, success: false, message: "Wallet not found", wallet: null };
    }

    return {
      code: 200,
      success: true,
      message: "Wallet details retrieved successfully",
      user,
      wallet: {
        availableBalance: parseFloat(balance.availableBalance.toFixed(2)),
        suspendedBalance: parseFloat(balance.suspendedBalance.toFixed(2)),
        methods: balance.methods,
      },
    };
  },

  getUserTransactions: async (
    _: unknown,
    { first, after, last, before }: { first?: number; after?: string; last?: number; before?: string },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const db = getDB();
    const walletsDB = getWalletsDB();

    const user = await db.collection<User>("users").findOne({ id: userId });

    const allTransactions = await walletsDB
      .collection<Transaction>("Transactions")
      .find({ userId })
      .sort({ createdAt: -1 })
      .toArray();

    const total = allTransactions.length;
    let start = 0;
    let end = total;

    if (first != null && after) {
      start = decodeCursor(after) + 1;
      end = Math.min(start + first, total);
    } else if (first != null) {
      end = Math.min(first, total);
    } else if (last != null && before) {
      end = decodeCursor(before);
      start = Math.max(end - last, 0);
    } else if (last != null) {
      start = Math.max(total - last, 0);
    }

    const sliced = allTransactions.slice(start, end);

    const edges = sliced.map((t, i) => ({
      cursor: encodeCursor(start + i),
      node: {
        id: t.id,
        type: t.type,
        status: t.status,
        method: t.method,
        amount: t.amount,
        createdAt: t.createdAt,
      },
    }));

    return {
      code: 200,
      success: true,
      message: `${total} transaction(s) found`,
      user,
      transactions: {
        edges,
        pageInfo: {
          hasNextPage: end < total,
          hasPreviousPage: start > 0,
          startCursor: edges.length ? edges[0].cursor : null,
          endCursor: edges.length ? edges[edges.length - 1].cursor : null,
          fetchedCount: edges.length,
          remainingCount: total - end,
        },
      },
    };
  },
};

export const walletsMutations = {
  userDeposit: async (
    _: unknown,
    { input }: { input: { amount: number } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const { amount } = input;

    if (amount <= 0) {
      return { code: 400, success: false, message: "Amount must be greater than 0", deposit: null, paymentData: null };
    }

    const db = getDB();
    const user = await db.collection<User>("users").findOne({ id: userId });

    if (!user) {
      return { code: 404, success: false, message: "User not found", deposit: null, paymentData: null };
    }

    if (!user.isVerified) {
      return { code: 403, success: false, message: "Please verify your account before making a deposit", deposit: null, paymentData: null };
    }

    // 0.2% fee for regular users, 0% for premium
    const feeRate = user.isPremium ? 0 : 0.002;
    const fee = Math.round(amount * feeRate * 100) / 100;
    const totalCharged = Math.round((amount + fee) * 100) / 100;

    const apiKey = process.env.GAMEKET_PAY_API_KEY;
    if (!apiKey) {
      throw new Error("Server configuration error");
    }

    let paymentResponse;
    try {
      const res = await fetch("https://api.pay.gameket.io/create-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, amount: totalCharged }),
      });

      paymentResponse = await res.json();

      if (!res.ok) {
        return {
          code: res.status,
          success: false,
          message: "Payment service error",
          deposit: null,
          paymentData: null,
        };
      }
    } catch {
      return {
        code: 502,
        success: false,
        message: "Unable to reach payment service",
        deposit: null,
        paymentData: null,
      };
    }

    // Generate base64 transaction ID without special characters
    const transactionId = randomBytes(24)
      .toString("base64")
      .replace(/[+/=]/g, "");

    const payId = String(paymentResponse.id || paymentResponse.payId || "");

    const walletsDB = getWalletsDB();
    const depositRecord: Deposit = {
      userId,
      payId,
      transactionId,
      paymentMethod: "Webcheckout",
      amount: totalCharged,
      status: "pending",
    };

    await walletsDB.collection<Deposit>("Deposits").insertOne(depositRecord);

    return {
      code: 200,
      success: true,
      message: "Deposit initiated successfully",
      user,
      deposit: {
        amount,
        fee,
        totalCharged,
      },
      paymentData: JSON.stringify(paymentResponse),
    };
  },

  addWalletOptions: async (
    _: unknown,
    { input }: { input: { value: string } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const value = input.value.trim();

    const name = "USDT";
    const network = "BSC";

    if (value.length === 0) {
      return { code: 400, success: false, message: "Value is required", method: null };
    }
    if (value.length > 200) {
      return { code: 400, success: false, message: "Value must be at most 200 characters", method: null };
    }

    const db = getDB();
    const walletsDB = getWalletsDB();
    const user = await db.collection<User>("users").findOne({ id: userId });
    const balances = walletsDB.collection<Balance>("Balances");

    const balance = await balances.findOne({ userId });
    if (!balance) {
      return { code: 404, success: false, message: "Wallet not found", method: null };
    }

    const method = { name, value, network, isActive: true };

    const exists = balance.methods.length > 0;
    if (exists) {
      await balances.updateOne(
        { userId },
        { $set: { "methods.0": method } }
      );
      return { code: 200, success: true, message: "Payment method updated successfully", user, method };
    }

    await balances.updateOne(
      { userId },
      { $push: { methods: method } }
    );

    return { code: 201, success: true, message: "Payment method added successfully", user, method };
  },
};
