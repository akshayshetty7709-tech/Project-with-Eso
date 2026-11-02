-- One PostgreSQL server, one database PER microservice (database-per-service pattern).
-- Services create their own tables on startup (CREATE TABLE IF NOT EXISTS).
-- In a big company each database would usually be its own managed instance (RDS / Cloud SQL / Azure DB)
-- and schema changes would be run by a migration tool (Flyway / Liquibase) from the CI/CD pipeline.
CREATE DATABASE userdb;
CREATE DATABASE restaurantdb;
CREATE DATABASE orderdb;
CREATE DATABASE paymentdb;
