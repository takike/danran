import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const targetEnv = process.argv[2];
if (targetEnv !== 'staging' && targetEnv !== 'production') {
  console.error('Usage: node scripts/verify-deployment-config.mjs <staging|production>');
  process.exit(1);
}

const configPath = path.join(projectRoot, 'dist/danran_local/wrangler.json');
if (!fs.existsSync(configPath)) {
  console.error(`Generated configuration file not found at: ${configPath}`);
  console.error('Ensure build step (e.g. pnpm build:staging / pnpm build:production) has run.');
  process.exit(1);
}

let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (err) {
  console.error(`Failed to parse ${configPath} as JSON:`, err);
  process.exit(1);
}

const EXPECTATIONS = {
  staging: {
    workerName: 'danran-staging',
    databaseName: 'danran-staging',
    databaseId: '6cfc0f40-0017-4f4a-8cd7-45744044c4db',
    bucketName: 'danran-photos-staging',
  },
  production: {
    workerName: 'danran',
    databaseName: 'danran-prod',
    databaseId: 'f2ce6e9c-d6e6-48e3-81f0-22189593e962',
    bucketName: 'danran-photos-prod',
  },
};

const expected = EXPECTATIONS[targetEnv];
const errors = [];

if (config.name !== expected.workerName) {
  errors.push(`Worker name mismatch: expected "${expected.workerName}", got "${config.name}"`);
}

const d1Databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
const dbBinding = d1Databases.find((db) => db.binding === 'DB');
if (!dbBinding) {
  errors.push('Missing "DB" D1 database binding');
} else {
  if (dbBinding.database_name !== expected.databaseName) {
    errors.push(
      `D1 database_name mismatch: expected "${expected.databaseName}", got "${dbBinding.database_name}"`,
    );
  }
  if (dbBinding.database_id !== expected.databaseId) {
    errors.push(
      `D1 database_id mismatch: expected "${expected.databaseId}", got "${dbBinding.database_id}"`,
    );
  }
  if (dbBinding.database_id === '00000000-0000-0000-0000-000000000000') {
    errors.push('D1 database_id is pointing to the local development sentinel UUID');
  }
}

const r2Buckets = Array.isArray(config.r2_buckets) ? config.r2_buckets : [];
const photosBinding = r2Buckets.find((b) => b.binding === 'PHOTOS');
if (!photosBinding) {
  errors.push('Missing "PHOTOS" R2 bucket binding');
} else {
  if (photosBinding.bucket_name !== expected.bucketName) {
    errors.push(
      `R2 bucket_name mismatch: expected "${expected.bucketName}", got "${photosBinding.bucket_name}"`,
    );
  }
}

if (errors.length > 0) {
  console.error(`Target configuration verification failed for "${targetEnv}":`);
  for (const err of errors) {
    console.error(`  - ${err}`);
  }
  process.exit(1);
}

console.log(`Target configuration for "${targetEnv}" successfully verified:`);
console.log(`  - Worker: ${config.name}`);
console.log(`  - D1 (DB): ${dbBinding.database_name} (${dbBinding.database_id})`);
console.log(`  - R2 (PHOTOS): ${photosBinding.bucket_name}`);
