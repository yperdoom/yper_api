import mongoose from 'mongoose';

let connection = null;

/**
 * Conecta uma unica vez e reaproveita a promise nas chamadas seguintes.
 */
export function connectDB() {
  if (connection) return connection;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');

  mongoose.set('strictQuery', true);
  connection = mongoose.connect(uri, {
    dbName: process.env.MONGODB_DB || 'yper',
    serverSelectionTimeoutMS: 10000,
  });

  return connection;
}
