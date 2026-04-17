import { Router } from "express";
import { getDB, getWalletsDB } from "../db.js";
import type { Deposit, Transaction, Balance } from "../types.js";
import bcrypt from "bcryptjs";

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

  if (status === "completed") {
    // Credit user balance
    await walletsDB.collection<Balance>("Balances").updateOne(
      { userId: deposit.userId },
      { $inc: { availableBalance: deposit.amount } }
    );

    // Update deposit status
    await walletsDB.collection<Deposit>("Deposits").updateOne(
      { payId: txnid },
      { $set: { status: "completed" } }
    );

    // Update transaction status
    await walletsDB.collection<Transaction>("Transactions").updateOne(
      { id: deposit.transactionId },
      { $set: { status: "completed" } }
    );

    res.status(200).json({ success: true, message: "Deposit completed" });
  } else {
    // Mark as failed for any non-completed status
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
});

export default router;
