use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Map, Value};

use super::{Encoder, encode_transport, required_text};
use crate::transport::RuntimeTransportError;

impl Encoder {
    pub(super) fn tagged(
        &mut self,
        object: &Map<String, Value>,
        kind: &str,
    ) -> Result<(), RuntimeTransportError> {
        match kind {
            "BigInt" => self.bigint(required_text(object, "value")?),
            "TypedArray" if required_text(object, "kind")? == "Uint8Array" => {
                self.typed_array(object)
            }
            "Map" => self.map(object),
            "Set" => self.set(object),
            _ => Err(RuntimeTransportError::MessagePack(format!("tag:{kind}"))),
        }
    }

    fn typed_array(&mut self, object: &Map<String, Value>) -> Result<(), RuntimeTransportError> {
        let bytes = BASE64
            .decode(required_text(object, "value")?)
            .map_err(|_| RuntimeTransportError::MessagePack("typed-array".into()))?;
        let payload_length = bytes.len().saturating_add(1);
        if let Ok(length) = u8::try_from(payload_length) {
            self.bytes.extend_from_slice(&[0xc7, length]);
        } else if let Ok(length) = u16::try_from(payload_length) {
            self.bytes.push(0xc8);
            self.bytes.extend_from_slice(&length.to_be_bytes());
        } else {
            let length = u32::try_from(payload_length)
                .map_err(|_| RuntimeTransportError::MessagePack("typed-array-length".into()))?;
            self.bytes.push(0xc9);
            self.bytes.extend_from_slice(&length.to_be_bytes());
        }
        self.bytes.push(0x74);
        self.bytes.push(1);
        self.bytes.extend_from_slice(&bytes);
        Ok(())
    }

    fn map(&mut self, object: &Map<String, Value>) -> Result<(), RuntimeTransportError> {
        let rows = object
            .get("value")
            .and_then(Value::as_array)
            .ok_or_else(|| RuntimeTransportError::MessagePack("map".into()))?;
        let mut ordered = rows
            .iter()
            .map(map_sort_row)
            .collect::<Result<Vec<_>, RuntimeTransportError>>()?;
        ordered.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
        self.map_len(ordered.len())?;
        for (_, _, pair) in ordered {
            self.value(&pair[0])?;
            self.value(&pair[1])?;
        }
        Ok(())
    }

    fn set(&mut self, object: &Map<String, Value>) -> Result<(), RuntimeTransportError> {
        let rows = object
            .get("value")
            .and_then(Value::as_array)
            .ok_or_else(|| RuntimeTransportError::MessagePack("set".into()))?;
        let mut ordered = rows
            .iter()
            .map(|row| Ok((encode_transport(row)?, row)))
            .collect::<Result<Vec<_>, RuntimeTransportError>>()?;
        ordered.sort_by(|left, right| left.0.cmp(&right.0));
        self.extension(0x73, &[0])?;
        self.array_len(ordered.len())?;
        for (_, row) in ordered {
            self.value(row)?;
        }
        Ok(())
    }
}

type MapSortRow<'a> = (Vec<u8>, Vec<u8>, &'a Vec<Value>);

fn map_sort_row(row: &Value) -> Result<MapSortRow<'_>, RuntimeTransportError> {
    let pair = row
        .as_array()
        .filter(|pair| pair.len() == 2)
        .ok_or_else(|| RuntimeTransportError::MessagePack("map-row".into()))?;
    Ok((
        encode_transport(&pair[0])?,
        encode_transport(&pair[1])?,
        pair,
    ))
}
