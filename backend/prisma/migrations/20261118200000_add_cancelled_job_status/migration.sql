-- AlterEnum
-- A job the client withdrew before funding it. Existing rows keep their status;
-- the new value is only ever written by POST /api/jobs/:id/cancel (issue #81).
ALTER TYPE "JobStatus" ADD VALUE 'CANCELLED';
