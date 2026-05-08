import { Router } from "express";
import { randomBytes } from "crypto";
import { getDB, getWalletsDB, getCatalogsDB } from "../db.js";
import { decryptCodeOrPlain } from "../utils/codeCrypto.js";
import type { Deposit, Transaction, Balance, Order, Product, Store, User } from "../types.js";
import bcrypt from "bcryptjs";
import nodemailer from "nodemailer";
import { readFileSync } from "fs";
import { join } from "path";

function getRankFromSales(totalSales: number): number {
  if (totalSales >= 10000) return 10;
  if (totalSales >= 9000) return 9;
  if (totalSales >= 7500) return 8;
  if (totalSales >= 5000) return 7;
  if (totalSales >= 3500) return 6;
  if (totalSales >= 2500) return 5;
  if (totalSales >= 1000) return 4;
  if (totalSales >= 500) return 3;
  if (totalSales >= 100) return 2;
  return 1;
}

const router = Router();

const smtpTransporter = nodemailer.createTransport({
  host: "gameket.io",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
});

const escapeHtml = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/\"/g, "&quot;")
  .replace(/'/g, "&#39;");

const formatUsd = (amount: number): string => {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
};

const formatDateTime = (iso: string): string => {
  return new Date(iso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
};

const renderDepositConfirmedEmail = (
  user: User,
  deposit: Deposit,
  walletBalance: number,
  confirmedOnIso: string,
  network: string | undefined
): string => {
  const template = readFileSync(join(process.cwd(), "src", "emails", "deposit-confirmed-email.html"), "utf-8");
  const firstName = user.username.trim() || "there";
  const confirmedOn = new Date(confirmedOnIso).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{depositAmount\}\}/g, escapeHtml(formatUsd(deposit.amount)))
    .replace(/\{\{transactionId\}\}/g, escapeHtml(deposit.transactionId || deposit.payId))
    .replace(/\{\{confirmedOn\}\}/g, escapeHtml(confirmedOn))
    .replace(/\{\{paymentMethod\}\}/g, escapeHtml(network || deposit.paymentMethod || "N/A"))
    .replace(/\{\{walletBalance\}\}/g, escapeHtml(formatUsd(walletBalance)))
    .replace(/\{\{walletUrl\}\}/g, escapeHtml("https://shop.gameket.io/user/wallet"))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

const renderStoreCodeSoldEmail = (
  seller: User,
  input: {
    storeName: string;
    orderId: string;
    productName: string;
    quantity: number;
    soldOn: string;
    buyerTag: string;
    grossAmount: number;
    platformFee: number;
    netEarnings: number;
    payoutTimeline: string;
  }
): string => {
  const template = readFileSync(join(process.cwd(), "src", "emails", "store-code-sold-email.html"), "utf-8");
  const firstName = seller.username.trim() || "there";

  return template
    .replace(/\{\{firstName\}\}/g, escapeHtml(firstName))
    .replace(/\{\{storeName\}\}/g, escapeHtml(input.storeName))
    .replace(/\{\{orderId\}\}/g, escapeHtml(input.orderId))
    .replace(/\{\{productName\}\}/g, escapeHtml(input.productName))
    .replace(/\{\{quantity\}\}/g, String(input.quantity))
    .replace(/\{\{soldOn\}\}/g, escapeHtml(formatDateTime(input.soldOn)))
    .replace(/\{\{buyerTag\}\}/g, escapeHtml(input.buyerTag))
    .replace(/\{\{grossAmount\}\}/g, escapeHtml(formatUsd(input.grossAmount)))
    .replace(/\{\{platformFee\}\}/g, escapeHtml(formatUsd(input.platformFee)))
    .replace(/\{\{netEarnings\}\}/g, escapeHtml(formatUsd(input.netEarnings)))
    .replace(/\{\{payoutTimeline\}\}/g, escapeHtml(input.payoutTimeline))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

const renderGuestAutomaticOrderEmail = (
  input: {
    orderId: string;
    orderDate: string;
    deliveredOn: string;
    productName: string;
    codes: string[];
    quantity: number;
    totalAmount: number;
    paymentMethod: string;
  }
): string => {
  let template = readFileSync(join(process.cwd(), "src", "emails", "guest-automatic-order-email.html"), "utf-8");
  const cleanCodes = input.codes.filter((value) => value.trim().length > 0);

  template = template.replace(/\{\{#if purchasedCodes\}\}([\s\S]*?)\{\{\/if\}\}/g, (_full, block: string) => {
    if (cleanCodes.length <= 1) return "";
    return block.replace(/\{\{#each purchasedCodes\}\}([\s\S]*?)\{\{\/each\}\}/g, (_eachFull, eachBlock: string) => {
      return cleanCodes
        .map((code) => eachBlock.replace(/\{\{this\}\}/g, escapeHtml(code)))
        .join("");
    });
  });

  template = template.replace(/\{\{#if purchasedCode\}\}([\s\S]*?)\{\{\/if\}\}/g, (_full, block: string) => {
    if (cleanCodes.length !== 1) return "";
    return block.replace(/\{\{purchasedCode\}\}/g, escapeHtml(cleanCodes[0]));
  });

  return template
    .replace(/\{\{orderId\}\}/g, escapeHtml(input.orderId))
    .replace(/\{\{orderDate\}\}/g, escapeHtml(formatDateTime(input.orderDate)))
    .replace(/\{\{deliveredOn\}\}/g, escapeHtml(formatDateTime(input.deliveredOn)))
    .replace(/\{\{productName\}\}/g, escapeHtml(input.productName))
    .replace(/\{\{quantity\}\}/g, String(input.quantity))
    .replace(/\{\{orderTotal\}\}/g, escapeHtml(formatUsd(input.totalAmount)))
    .replace(/\{\{paymentMethod\}\}/g, escapeHtml(input.paymentMethod))
    .replace(/\{\{year\}\}/g, String(new Date().getFullYear()));
};

router.post("/webhook/deposit", async (req, res) => {
  const { txnid, status, amount, network, createdAt, privateKey } = req.body;

  if (!txnid || !status || !privateKey) {
    res.status(400).json({ success: false, message: "Missing required fields" });
    return;
  }

  const db = getDB();
  const walletsDB = getWalletsDB();

  // Verify private key against Auth collection
  const authRecord = await db.collection("Auth").findOne({ key: "privateKey" });
  if (!authRecord) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }

  const isValid = await bcrypt.compare(privateKey, authRecord.value);
  if (!isValid) {
    res.status(401).json({ success: false, message: "Unauthorized" });
    return;
  }

  // Find deposit by payId (txnid from gateway)
  const deposit = await walletsDB.collection<Deposit>("Deposits").findOne({ payId: txnid });
  if (!deposit) {
    res.status(404).json({ success: false, message: "Deposit not found" });
    return;
  }

  if (deposit.status !== "pending") {
    res.status(409).json({ success: false, message: "Deposit already processed" });
    return;
  }

  if (amount !== deposit.totalCharged) {
    res.status(400).json({ success: false, message: "Amount mismatch" });
    return;
  }

  if (deposit.type === "deposit") {
    // --- Regular deposit flow ---
    if (status === "completed") {
      const updatedBalance = await walletsDB.collection<Balance>("Balances").findOneAndUpdate(
        { userId: deposit.userId },
        { $inc: { availableBalance: deposit.amount } },
        { returnDocument: "after" }
      );

      await walletsDB.collection<Deposit>("Deposits").updateOne(
        { payId: txnid },
        { $set: { status: "completed" } }
      );

      await walletsDB.collection<Transaction>("Transactions").updateOne(
        { id: deposit.transactionId },
        { $set: { status: "completed" } }
      );

      const user = await db.collection<User>("users").findOne({ id: deposit.userId });
      if (user) {
        try {
          const html = renderDepositConfirmedEmail(
            user,
            deposit,
            updatedBalance?.availableBalance ?? deposit.amount,
            createdAt || new Date().toISOString(),
            network
          );

          await smtpTransporter.sendMail({
            from: process.env.SMTP_EMAIL,
            to: user.email,
            subject: "Deposit Confirmed - Wallet Credited",
            html,
          });
        } catch (error) {
          console.error("Failed to send deposit confirmation email:", error);
        }
      }

      res.status(200).json({ success: true, message: "Deposit completed" });
    } else {
      await walletsDB.collection<Deposit>("Deposits").updateOne(
        { payId: txnid },
        { $set: { status: "failed" } }
      );

      await walletsDB.collection<Transaction>("Transactions").updateOne(
        { id: deposit.transactionId },
        { $set: { status: "failed" } }
      );

      res.status(200).json({ success: true, message: "Deposit marked as failed" });
    }
  } else if (deposit.type === "codepurchase") {
    // --- Anonymous code purchase flow ---
    if (!deposit.orderId || !deposit.sellerId || !deposit.storeId || !deposit.productId || !deposit.quantity) {
      res.status(400).json({ success: false, message: "Incomplete deposit data" });
      return;
    }

    if (status === "completed") {
      const catalogsDB = getCatalogsDB();
      const product = await catalogsDB.collection<Product>("Products").findOne({ productId: deposit.productId });
      const availableStock = product
        ? (product.type === "Manual" ? product.available : product.availableCodes.length)
        : 0;

      if (!product || availableStock < deposit.quantity) {
        await walletsDB.collection<Deposit>("Deposits").updateOne(
          { payId: txnid },
          { $set: { status: "failed" } }
        );
        res.status(400).json({ success: false, message: "Product stock no longer available" });
        return;
      }

      const quantity = deposit.quantity;
      const purchasedCodes = product.type === "Manual"
        ? []
        : product.availableCodes.slice(0, quantity);
      const isManual = product.type === "Manual";
      const remainingCodes = isManual
        ? product.availableCodes
        : product.availableCodes.slice(quantity);
      const orderStatus = isManual ? "billed" : "completed";
      const now = new Date().toISOString();
      const releasedAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      if (product.type === "Manual") {
        await catalogsDB.collection<Product>("Products").updateOne(
          { productId: deposit.productId },
          {
            $inc: { available: -quantity, sold: quantity },
            $set: { isActive: (product.available - quantity) > 0 },
          }
        );
      } else {
        // Move codes from available to sold
        await catalogsDB.collection<Product>("Products").updateOne(
          { productId: deposit.productId },
          {
            $set: { availableCodes: remainingCodes },
            $push: { soldCodes: { $each: purchasedCodes } },
            $inc: { available: -quantity, sold: quantity },
          }
        );
      }

      // Update store total sales
      const updatedStore = await catalogsDB.collection<Store>("Stores").findOneAndUpdate(
        { storeId: deposit.storeId },
        { $inc: { totalSales: quantity } },
        { returnDocument: "after" }
      );

      // Update seller rank based on new total sales
      if (updatedStore) {
        const newRank = getRankFromSales(updatedStore.totalSales);
        await db.collection<User>("users").updateOne(
          { id: deposit.sellerId },
          { $set: { rank: newRank } }
        );
      }

      // Credit seller's suspended balance
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: deposit.sellerId },
        { $inc: { suspendedBalance: deposit.amount } }
      );

      // Create seller transaction
      const sellerTransactionId = randomBytes(24).toString("base64").replace(/[+/=]/g, "");

      const sellerTransaction: Transaction = {
        userId: deposit.sellerId,
        id: sellerTransactionId,
        type: "SoldCodes",
        status: isManual ? "billed" : "pending",
        method: "balance",
        amount: deposit.amount,
        createdAt: now,
      };

      await walletsDB.collection<Transaction>("Transactions").insertOne(sellerTransaction);

      // Create order now that payment is confirmed
      const order: Order = {
        orderId: deposit.orderId,
        buyerId: "anon-gameket-id",
        buyerName: deposit.buyerName || "Guest",
        sellerId: deposit.sellerId,
        storeId: deposit.storeId,
        productId: deposit.productId,
        buyerTransactionId: "",
        sellerTransactionId,
        codes: purchasedCodes,
        quantity,
        amount: deposit.amount,
        fee: deposit.fee,
        totalAmount: deposit.totalCharged,
        status: orderStatus,
        type: "anonpurchase",
        isReviewed: false,
        reviewType: null,
        isReleased: false,
        disputeReason: null,
        datainput: deposit.datainput ?? null,
        createdAt: now,
        releasedAt,
      };

      await walletsDB.collection<Order>("Orders").insertOne(order);

      if (!isManual) {
        const seller = await db.collection<User>("users").findOne({ id: deposit.sellerId });

        try {
          const mailTasks: Array<Promise<unknown>> = [];

          if (seller) {
            const sellerHtml = renderStoreCodeSoldEmail(seller, {
              storeName: updatedStore?.storeName || "Your Store",
              orderId: deposit.orderId,
              productName: product.name,
              quantity,
              soldOn: now,
              buyerTag: deposit.buyerName || "Guest",
              grossAmount: deposit.amount,
              platformFee: deposit.fee,
              netEarnings: deposit.amount,
              payoutTimeline: "Funds release in up to 24 hours",
            });

            mailTasks.push(
              smtpTransporter.sendMail({
                from: process.env.SMTP_EMAIL,
                to: seller.email,
                subject: "Code Sold - New Store Order",
                html: sellerHtml,
              })
            );
          }

          const buyerHtml = renderGuestAutomaticOrderEmail({
            orderId: deposit.orderId,
            orderDate: now,
            deliveredOn: now,
            productName: product.name,
            codes: purchasedCodes.map((code) => decryptCodeOrPlain(code)),
            quantity,
            totalAmount: deposit.totalCharged,
            paymentMethod: deposit.paymentMethod || "Webcheckout",
          });

          mailTasks.push(
            smtpTransporter.sendMail({
              from: process.env.SMTP_EMAIL,
              to: deposit.userId,
              subject: "Guest Order Completed",
              html: buyerHtml,
            })
          );

          await Promise.allSettled(mailTasks);
        } catch (error) {
          console.error("Failed to send order notification emails:", error);
        }
      }

      // Update deposit status
      await walletsDB.collection<Deposit>("Deposits").updateOne(
        { payId: txnid },
        { $set: { status: "completed" } }
      );

      res.status(200).json({ success: true, message: "Purchase completed" });
    } else {
      await walletsDB.collection<Deposit>("Deposits").updateOne(
        { payId: txnid },
        { $set: { status: "failed" } }
      );

      res.status(200).json({ success: true, message: "Purchase marked as failed" });
    }
  } else {
    res.status(400).json({ success: false, message: "Unknown deposit type" });
  }
});

export default router;
