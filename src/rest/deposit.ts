import { Router } from "express";
import { randomBytes } from "crypto";
import { getDB, getWalletsDB, getCatalogsDB } from "../db.js";
import type { Deposit, Transaction, Balance, Order, Product, Store, User } from "../types.js";
import bcrypt from "bcryptjs";

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
      await walletsDB.collection<Balance>("Balances").updateOne(
        { userId: deposit.userId },
        { $inc: { availableBalance: deposit.amount } }
      );

      await walletsDB.collection<Deposit>("Deposits").updateOne(
        { payId: txnid },
        { $set: { status: "completed" } }
      );

      await walletsDB.collection<Transaction>("Transactions").updateOne(
        { id: deposit.transactionId },
        { $set: { status: "completed" } }
      );

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
      const remainingCodes = product.type === "Manual"
        ? product.availableCodes
        : product.availableCodes.slice(quantity);
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
        status: "pending",
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
        status: "completed",
        type: "anonpurchase",
        isReviewed: false,
        reviewType: null,
        isReleased: false,
        disputeReason: null,
        createdAt: now,
        releasedAt,
      };

      await walletsDB.collection<Order>("Orders").insertOne(order);

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
