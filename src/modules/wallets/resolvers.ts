import { randomBytes } from "crypto";
import { GraphQLError } from "graphql";
import { getDB } from "../../db.js";
import { getWalletsDB } from "../../db.js";
import type { User, Balance, Deposit } from "../../types.js";
import type { Context } from "../../index.js";

export const walletsQueries = {
  getUserWallets: async (_: unknown, __: unknown, context: Context) => {
    if (!context.user) {
      throw new GraphQLError(context.authError || "Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const walletsDB = getWalletsDB();

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
      wallet: {
        availableBalance: parseFloat(balance.availableBalance.toFixed(2)),
        suspendedBalance: parseFloat(balance.suspendedBalance.toFixed(2)),
        methods: balance.methods,
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

    const walletsDB = getWalletsDB();
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
      return { code: 200, success: true, message: "Payment method updated successfully", method };
    }

    await balances.updateOne(
      { userId },
      { $push: { methods: method } }
    );

    return { code: 201, success: true, message: "Payment method added successfully", method };
  },
};
