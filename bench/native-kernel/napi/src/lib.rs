use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

#[napi]
pub fn recover_batch(records: Buffer, threads: u32) -> napi::Result<Buffer> {
    if records.len() % 97 != 0 {
        return Err(napi::Error::from_reason("record length"));
    }
    let mut output = vec![0u8; records.len() / 97 * 20];
    let status = xln_native_kernel_bench::recover_batch(&records, &mut output, threads as usize);
    if status != 0 {
        return Err(napi::Error::from_reason(format!("recover status {status}")));
    }
    Ok(output.into())
}

#[napi]
pub fn sha256_batch(records: Buffer, stride: u32, threads: u32) -> napi::Result<Buffer> {
    if stride == 0 || records.len() % stride as usize != 0 {
        return Err(napi::Error::from_reason("record length"));
    }
    let mut output = vec![0u8; records.len() / stride as usize * 32];
    let status = xln_native_kernel_bench::sha256_batch(&records, stride as usize, &mut output, threads as usize);
    if status != 0 {
        return Err(napi::Error::from_reason(format!("hash status {status}")));
    }
    Ok(output.into())
}

