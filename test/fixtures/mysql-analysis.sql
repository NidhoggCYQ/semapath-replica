-- Synthetic fixture for a dedicated empty MySQL instance only.
-- Do not run against a shared or business server. No existing database is replaced.
CREATE DATABASE replica_fixture CHARACTER SET utf8mb4;
USE replica_fixture;
CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  customer VARCHAR(20),
  amount DECIMAL(65,20),
  memo VARCHAR(100)
);
INSERT INTO orders VALUES
  (9007199254740993001,'001',0.10,'first'),
  (9007199254740993002,'001',0.20,'second'),
  (9007199254740993003,'002',5,NULL),
  (9007199254740993004,'003',2.5,'unmatched');
CREATE TABLE precision_values (id BIGINT, amount DECIMAL(65,20));
INSERT INTO precision_values VALUES
  (9007199254740993123,12345678901234567890.12345678901234567890);
CREATE TABLE sequence_rows (n INT PRIMARY KEY);
INSERT INTO sequence_rows
  WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<1000)
  SELECT n FROM seq;
CREATE USER 'replica_reader'@'127.0.0.1' IDENTIFIED BY 'synthetic-test-secret';
GRANT SELECT ON replica_fixture.* TO 'replica_reader'@'127.0.0.1';
CREATE USER 'replica_writer'@'127.0.0.1' IDENTIFIED BY 'synthetic-writer-secret';
GRANT SELECT, UPDATE ON replica_fixture.* TO 'replica_writer'@'127.0.0.1';
