import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { openStorage } from '../src/gateway.ts';
import { openDatabase } from '../src/db/database.ts';
import { CredentialStore } from '../src/hosts/credentials.ts';
import { tempDir } from './helpers/tmp.ts';

const credential={hostId:'synthetic-host',accessToken:'synthetic-plaintext-bearer-marker',t3ClientId:'synthetic-client',scope:'orchestration:read',
  access:'read-only' as const,issuedAt:1,expiresAt:9000,verifiedAt:2};

test('native token envelope survives reopen without plaintext in database or WAL and is bound to its host', t => {
  const dir=tempDir(t); let {db}=openStorage(dir); let store=new CredentialStore(db);
  store.save(credential);
  const sealed=String(db.prepare('SELECT access_token FROM host_credentials').get()!.access_token);
  assert.ok(sealed.startsWith('sealed:v1:')); assert.ok(!sealed.includes(credential.accessToken));
  assert.equal(store.get(credential.hostId)!.accessToken,credential.accessToken);
  db.close(); db=openDatabase(join(dir,'gateway.db')); t.after(()=>db.close()); store=new CredentialStore(db);
  assert.equal(store.get(credential.hostId)!.accessToken,credential.accessToken);
  assert.ok(!readFileSync(join(dir,'gateway.db')).includes(Buffer.from(credential.accessToken)));
  db.prepare('UPDATE host_credentials SET host_id = ?').run('synthetic-other-host');
  assert.throws(()=>store.get('synthetic-other-host'),{code:'data_dir_insecure'});
});

test('wrong wrapping key fails closed and repeated saves use independent nonces', t => {
  const dir=tempDir(t); const {db}=openStorage(dir); t.after(()=>db.close()); const store=new CredentialStore(db);
  store.save(credential); const one=String(db.prepare('SELECT access_token FROM host_credentials').get()!.access_token);
  store.save(credential); const two=String(db.prepare('SELECT access_token FROM host_credentials').get()!.access_token);
  assert.notEqual(one,two);
  writeFileSync(join(dir,'gateway.key'),randomBytes(32),{mode:0o600});
  assert.throws(()=>new CredentialStore(db).get(credential.hostId),{code:'data_dir_insecure'});
});

test('native persistence refuses a missing wrapping key instead of falling back to plaintext', t => {
  const dir=tempDir(t); const {db}=openStorage(dir); t.after(()=>db.close());
  unlinkSync(join(dir,'gateway.key'));
  assert.throws(()=>new CredentialStore(db,true),{code:'data_dir_insecure'});
});
