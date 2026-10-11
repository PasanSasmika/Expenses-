import mongoose, { Schema, type InferSchemaType } from "mongoose";

const transactionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: ["income", "expense"], required: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    amount: { type: Number, required: true, min: 0.01 },
    date: { type: Date, required: true },
  },
  { timestamps: true }
);

transactionSchema.index({ user: 1, date: -1 });
export type TransactionDocument = InferSchemaType<typeof transactionSchema>;
export const Transaction = mongoose.model("Transaction", transactionSchema);
