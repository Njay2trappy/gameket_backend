import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { GraphQLError } from "graphql";
import { getDB, getWalletsDB } from "../../db.js";
import type { User, Account, Balance } from "../../types.js";
import type { Context } from "../../index.js";

export const authQueries = {};

export const authMutations = {
  register: async (
    _: unknown,
    { input }: { input: { email: string; username: string; country: string; password: string } }
  ) => {
    const db = getDB();
    const users = db.collection<User>("users");
    const accounts = db.collection<Account>("accounts");

    const email = input.email.trim().toLowerCase();
    const username = input.username.trim();
    const country = input.country.trim();
    const password = input.password;

    // Validate email format
    if (email.length > 254) {
      return { code: 400, success: false, message: "Email is too long", user: null };
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { code: 400, success: false, message: "Invalid email format", user: null };
    }

    // Validate username: max 15 chars, no spaces
    if (username.length === 0) {
      return { code: 400, success: false, message: "Username is required", user: null };
    }
    if (username.length > 15) {
      return { code: 400, success: false, message: "Username must be at most 15 characters", user: null };
    }
    if (/\s/.test(username)) {
      return { code: 400, success: false, message: "Username must not contain spaces", user: null };
    }

    // Validate country
    if (country.length === 0) {
      return { code: 400, success: false, message: "Country is required", user: null };
    }
    if (country.length > 100) {
      return { code: 400, success: false, message: "Country name is too long", user: null };
    }

    // Validate password
    if (password.length < 8) {
      return { code: 400, success: false, message: "Password must be at least 8 characters", user: null };
    }
    if (password.length > 128) {
      return { code: 400, success: false, message: "Password must be at most 128 characters", user: null };
    }
    if (!/[A-Z]/.test(password)) {
      return { code: 400, success: false, message: "Password must contain at least one uppercase letter", user: null };
    }
    if (!/[a-z]/.test(password)) {
      return { code: 400, success: false, message: "Password must contain at least one lowercase letter", user: null };
    }
    if (!/[0-9]/.test(password)) {
      return { code: 400, success: false, message: "Password must contain at least one number", user: null };
    }

    // Check uniqueness
    if (await accounts.findOne({ email })) {
      return { code: 400, success: false, message: "Invalid registration details", user: null };
    }
    if (await users.findOne({ username: { $regex: `^${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } })) {
      return { code: 400, success: false, message: "Invalid registration details", user: null };
    }

    const userId = uuidv4();
    const registered = new Date().toISOString();
    const hashedPassword = await bcrypt.hash(password, 12);

    const user: User = {
      id: userId,
      username,
      email,
      country,
      isActive: true,
      isVerified: false,
      isPremium: false,
      rank: 1,
      registered,
      isStore: false,
      avatar: null,
    };

    const account: Account = {
      userId,
      email,
      password: hashedPassword,
      twoFactorAuth: false,
      lastLogin: null,
      tokenVersion: 0,
    };

    await users.insertOne(user);
    await accounts.insertOne(account);

    // Create wallet balance
    const walletsDb = getWalletsDB();
    const balances = walletsDb.collection<Balance>("Balances");

    const balance: Balance = {
      userId,
      availableBalance: 0,
      suspendedBalance: 0,
      methods: [],
    };

    await balances.insertOne(balance);

    return { code: 201, success: true, message: "Registration successful", user: { ...user, twoFactorAuth: false } };
  },

  login: async (
    _: unknown,
    { input }: { input: { email: string; password: string } }
  ) => {
    const db = getDB();
    const accounts = db.collection<Account>("accounts");
    const users = db.collection<User>("users");

    const email = input.email.trim().toLowerCase();
    const password = input.password;

    const account = await accounts.findOne({ email });
    if (!account) {
      return { code: 401, success: false, message: "Invalid email or password", token: null, user: null };
    }

    const valid = await bcrypt.compare(password, account.password);
    if (!valid) {
      return { code: 401, success: false, message: "Invalid email or password", token: null, user: null };
    }

    const user = await users.findOne({ id: account.userId });
    if (!user) {
      return { code: 401, success: false, message: "Invalid email or password", token: null, user: null };
    }

    if (!user.isActive) {
      return { code: 403, success: false, message: "Account is deactivated", token: null, user: null };
    }

    // Increment tokenVersion to invalidate all previous sessions
    const newTokenVersion = (account.tokenVersion ?? 0) + 1;

    await accounts.updateOne(
      { userId: account.userId },
      { $set: { lastLogin: new Date().toISOString(), tokenVersion: newTokenVersion } }
    );

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error("Server configuration error");
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email, tokenVersion: newTokenVersion },
      secret,
      { expiresIn: "1h" }
    );

    return { code: 200, success: true, message: "Login successful", token, user: { ...user, twoFactorAuth: account.twoFactorAuth } };
  },

  updatePassword: async (
    _: unknown,
    { input }: { input: { oldPassword: string; newPassword: string } },
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError("Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;
    const { oldPassword, newPassword } = input;

    const db = getDB();
    const accounts = db.collection<Account>("accounts");

    const account = await accounts.findOne({ userId });
    if (!account) {
      return { code: 404, success: false, message: "Account not found" };
    }

    // Verify old password matches current password
    const valid = await bcrypt.compare(oldPassword, account.password);
    if (!valid) {
      return { code: 401, success: false, message: "Current password is incorrect" };
    }

    // Validate new password
    if (newPassword.length < 8) {
      return { code: 400, success: false, message: "Password must be at least 8 characters" };
    }
    if (newPassword.length > 128) {
      return { code: 400, success: false, message: "Password must be at most 128 characters" };
    }
    if (!/[A-Z]/.test(newPassword)) {
      return { code: 400, success: false, message: "Password must contain at least one uppercase letter" };
    }
    if (!/[a-z]/.test(newPassword)) {
      return { code: 400, success: false, message: "Password must contain at least one lowercase letter" };
    }
    if (!/[0-9]/.test(newPassword)) {
      return { code: 400, success: false, message: "Password must contain at least one number" };
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Update password and increment tokenVersion to force re-login
    const newTokenVersion = (account.tokenVersion ?? 0) + 1;

    await accounts.updateOne(
      { userId },
      { $set: { password: hashedPassword, tokenVersion: newTokenVersion } }
    );

    return { code: 200, success: true, message: "Password updated successfully. Please log in again." };
  },

  updateTwoFactorAuth: async (
    _: unknown,
    __: unknown,
    context: Context
  ) => {
    if (!context.user) {
      throw new GraphQLError("Authentication required", {
        extensions: { code: "UNAUTHENTICATED" },
      });
    }

    const { userId } = context.user;

    const db = getDB();
    const accounts = db.collection<Account>("accounts");

    const account = await accounts.findOne({ userId });
    if (!account) {
      return { code: 404, success: false, message: "Account not found", twoFactorAuth: null };
    }

    const newValue = !account.twoFactorAuth;

    await accounts.updateOne(
      { userId },
      { $set: { twoFactorAuth: newValue } }
    );

    const message = newValue
      ? "Two-factor authentication enabled"
      : "Two-factor authentication disabled";

    return { code: 200, success: true, message, twoFactorAuth: newValue };
  },
};
