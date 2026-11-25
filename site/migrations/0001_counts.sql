-- Visitor statistics for iskra.foo: daily totals only. No IP addresses, no visitor ids, no rows per visit.
-- site/_worker.js runs the same statement by itself when the table is missing, so applying this by hand is optional.
CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind, name)) WITHOUT ROWID;
