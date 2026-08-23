use std::io::{self, Read, Write};

fn read_u32(input: &mut impl Read) -> io::Result<Option<u32>> {
    let mut bytes = [0u8; 4];
    match input.read_exact(&mut bytes) {
        Ok(()) => Ok(Some(u32::from_le_bytes(bytes))),
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Ok(None),
        Err(error) => Err(error),
    }
}

fn main() -> io::Result<()> {
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    while let Some(op) = read_u32(&mut input)? {
        let count = read_u32(&mut input)?.expect("count") as usize;
        let stride = read_u32(&mut input)?.expect("stride") as usize;
        let threads = read_u32(&mut input)?.expect("threads") as usize;
        let input_len = match op { 1 => count * stride, 2 => count * 97, _ => 0 };
        let output_len = match op { 1 => count * 32, 2 => count * 20, _ => 0 };
        let mut request = vec![0u8; input_len];
        let mut response = vec![0u8; output_len];
        input.read_exact(&mut request)?;
        let status = match op {
            1 => xln_native_kernel_bench::sha256_batch(&request, stride, &mut response, threads),
            2 => xln_native_kernel_bench::recover_batch(&request, &mut response, threads),
            _ => -1,
        };
        output.write_all(&status.to_le_bytes())?;
        output.write_all(&(response.len() as u32).to_le_bytes())?;
        output.write_all(&response)?;
        output.flush()?;
    }
    Ok(())
}

