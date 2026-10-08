use super::*;
use crate::signed_profile::{ProfileTransportIdentity, signed_entity_profile};
use crate::storage::native::RuntimeFrameCommit;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn signed_profiles_precede_durable_entity_inputs_and_reconnect_refreshes() {
    let mut replica = processor_replica_with_pinned_peer(
        ENTITY_SEED,
        SOURCE_SEED,
        signing_entity_id(&hex(&[0x7b; 32])),
        true,
    );
    let key = entity_key(&replica);
    let mut ingress = DirectRuntimeIngress::bind(DirectRuntimeIngressConfig::production(
        "127.0.0.1:0".parse().unwrap(),
        SOURCE_SEED,
        SOURCE_SIGNER,
    ))
    .unwrap();
    ingress.set_delivery_ready(true).unwrap();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .unwrap();
    let directory = path();
    let mut store =
        NativeRuntimeStore::open(directory.join("db"), NativeStorageConfig::default()).unwrap();
    let client_seed = "native-profile-wire-client";
    let client_id = derive_local_runtime_id(client_seed, "1").unwrap();
    let mut publisher = DirectOutboxPublisher::new(DirectOutboxPublisherConfig::production(
        SOURCE_SEED,
        SOURCE_SIGNER,
        DirectRouteTable::new([]).unwrap(),
    ))
    .unwrap();
    publisher.attach_inbound_sessions(ingress.sessions());
    for revision in 1..=2_u64 {
        replica
            .state
            .e_replicas
            .get_mut(&key)
            .unwrap()
            .entity
            .profile
            .name = format!("revision-{revision}");
        let state = &replica.state.e_replicas[&key];
        let live = replica.e_replicas.get_mut(&key).unwrap();
        let rows = live
            .accounts
            .read_account_views(
                crate::signed_profile_accounts::account_ids(state).unwrap(),
                crate::signed_profile_accounts::project_account,
            )
            .unwrap();
        let profile = signed_entity_profile(
            state,
            live,
            revision,
            &ProfileTransportIdentity {
                runtime_id: ingress.runtime_id().into(),
                runtime_encryption_public_key: ingress.encryption_public_key(),
                ws_url: format!("ws://{}/ws", ingress.local_address()),
            },
            1,
            &BigInt::from(0),
            rows,
        )
        .unwrap();
        assert_eq!(profile["accounts"].as_array().unwrap().len(), 1);
        ingress.sessions().publish_profiles(vec![profile]).unwrap();
        let child = Command::new("bun")
            .args(["-e", CLIENT])
            .current_dir(&root)
            .env("RRS_TARGET_RUNTIME_ID", ingress.runtime_id())
            .env(
                "RRS_TARGET_URL",
                format!("ws://{}/ws", ingress.local_address()),
            )
            .env("RRS_TARGET_SEED", SOURCE_SEED)
            .env("RRS_CLIENT_SEED", client_seed)
            .env("RRS_REVISION", revision.to_string())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let request = ingress
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .expect("client ready signal");
        assert_eq!(request.peer_runtime_id, client_id);
        let durable = store
            .append_frame(frame(revision, vec![output_row(&client_id, revision)]))
            .unwrap();
        publisher.publish_durable(&mut store, &durable).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let evidence: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(evidence["order"], json!(["profile", "entity_inputs"]));
        assert_eq!(evidence["revision"], revision);
        let deadline = Instant::now() + Duration::from_secs(3);
        while ingress.has_open_session(&client_id).unwrap() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!ingress.has_open_session(&client_id).unwrap());
        assert_eq!(publisher.retry_pending().unwrap().rows_pending, 0);
    }
    drop(publisher);
    ingress.shutdown().unwrap();
    drop(store);
    std::fs::remove_dir_all(directory).unwrap();
}

const CLIENT: &str = r#"
import { deriveSignerAddressSync } from './core/account/crypto.ts';
import { RuntimeWsClient } from './core/network/p2p/ws-client.ts';
import { directRuntimeWsAudience } from './core/network/p2p/ws-protocol.ts';
import { deriveEncryptionKeyPair } from './core/protocol/crypto/p2p-crypto.ts';
import { verifyProfileSignature } from './core/entity/profile/profile-signing.ts';
const target=process.env.RRS_TARGET_RUNTIME_ID, seed=process.env.RRS_CLIENT_SEED;
const revision=Number(process.env.RRS_REVISION), order=[];
let resolve, reject;
const complete=new Promise((yes,no)=>{resolve=yes;reject=no;});
const timer=setTimeout(()=>reject(new Error('PROFILE_WIRE_TIMEOUT')),5000);
let verified=false;
const client=new RuntimeWsClient({url:process.env.RRS_TARGET_URL,
 runtimeId:deriveSignerAddressSync(seed,'1').toLowerCase(),signerId:'1',seed,
 helloAudience:directRuntimeWsAudience(target),encryptionKeyPair:deriveEncryptionKeyPair(seed),
 getTargetEncryptionKey:()=>deriveEncryptionKeyPair(process.env.RRS_TARGET_SEED).publicKey,
 onError:reject,
 onGossipAnnounce:async(from,payload)=>{
  if(from!==target || payload.profiles.length!==1) throw new Error('PROFILE_WIRE_OWNER');
  const profile=payload.profiles[0];
  const proof=await verifyProfileSignature(profile);
  if(!proof.valid) throw new Error(`PROFILE_SIGNATURE:${proof.reason}`);
  if(profile.runtimeId!==target || profile.name!==`revision-${revision}` || profile.accounts.length!==1)
    throw new Error('PROFILE_WIRE_STALE_OR_INCOMPLETE');
  verified=true;order.push('profile');
 },
 onEntityInputs:(_from,envelope,_timestamp,authenticated)=>{
  if(!verified || !authenticated || envelope.sourceRuntimeHeight!==revision)
    throw new Error('PROFILE_MUST_PRECEDE_AUTHENTICATED_OUTPUT');
  order.push('entity_inputs');resolve();
 }});
await client.connect();
const deadline=Date.now()+3000;
while(!client.canDeliver()&&Date.now()<deadline) await Bun.sleep(5);
if(!client.canDeliver()) throw new Error('CLIENT_HANDSHAKE_TIMEOUT');
client.setReady(true);
if(!client.sendEntityInputsRaw(target,{sourceRuntimeId:deriveSignerAddressSync(seed,'1').toLowerCase(),
 sourceRuntimeHeight:revision,sourceRuntimeTimestamp:123,
 entityInputs:[{runtimeId:target,entityId:'0x'+'11'.repeat(32),signerId:'1',entityTxs:[]}]},123))
 throw new Error('CLIENT_READY_SEND');
await complete;clearTimeout(timer);await client.closeAndWait(1000);
process.stdout.write(JSON.stringify({revision,order}));
"#;

fn output_row(target: &str, source_height: u64) -> Vec<u8> {
    crate::encode_storage_payload(&object(vec![
        ("runtimeId", CanonicalValue::String(target.into())),
        (
            "entityId",
            CanonicalValue::String(format!("0x{}", "11".repeat(32))),
        ),
        ("signerId", CanonicalValue::String("1".into())),
        ("entityTxs", CanonicalValue::Array(vec![])),
        (
            "sourceRuntimeFrame",
            object(vec![
                ("height", number(source_height)),
                ("timestamp", number(123)),
            ]),
        ),
    ]))
    .expect("canonical outbox row")
}

fn frame(height: u64, outputs: Vec<Vec<u8>>) -> RuntimeFrameCommit {
    build_runtime_frame_commit(
        CanonicalRuntimeFrameDraft {
            height,
            timestamp: 123,
            prev_frame_hash: [0; 32],
            replica_meta_digest: [0x11; 32],
            runtime_component_digests: vec![],
            materialized_state: false,
            canonical_state: None,
            runtime_input: json!({"runtimeTxs": [], "entityInputs": []}),
            runtime_machine_root: None,
            account_authority_checkpoints: vec![],
            touched_entities: vec![],
            touched_accounts: vec![],
            touched_book_entities: vec![],
        },
        crate::storage::native::EntityContextPayloadRows::empty(),
        outputs,
        None,
    )
    .expect("canonical frame")
    .commit
}

fn number(value: u64) -> CanonicalValue {
    CanonicalValue::Number(CanonicalNumber::try_from_u64(value).expect("safe fixture number"))
}

fn object(entries: Vec<(&str, CanonicalValue)>) -> CanonicalValue {
    CanonicalValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}
