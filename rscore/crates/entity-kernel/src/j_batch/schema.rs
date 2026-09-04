use ethabi::ParamType;

fn array(tuple: Vec<ParamType>) -> ParamType {
    ParamType::Array(Box::new(ParamType::Tuple(tuple)))
}
fn uint() -> ParamType {
    ParamType::Uint(256)
}
fn int() -> ParamType {
    ParamType::Int(256)
}
fn word() -> ParamType {
    ParamType::FixedBytes(32)
}
fn address() -> ParamType {
    ParamType::Address
}
fn bytes() -> ParamType {
    ParamType::Bytes
}

pub fn proof_body() -> ParamType {
    ParamType::Tuple(vec![
        word(),
        ParamType::Uint(32),
        ParamType::Uint(32),
        ParamType::Array(Box::new(int())),
        ParamType::Array(Box::new(uint())),
        array(vec![
            address(),
            bytes(),
            array(vec![uint(), uint(), uint()]),
        ]),
    ])
}

pub fn final_dispute() -> ParamType {
    ParamType::Tuple(vec![
        word(),
        uint(),
        uint(),
        ParamType::Bool,
        word(),
        proof_body(),
        bytes(),
        bytes(),
        bytes(),
        ParamType::Bool,
        ParamType::Bool,
    ])
}

pub(crate) fn batch() -> ParamType {
    ParamType::Tuple(vec![
        array(vec![word(), uint(), uint()]),
        array(vec![uint(), word(), array(vec![word(), uint()])]),
        array(vec![word(), uint(), uint(), uint(), bytes()]),
        array(vec![
            word(),
            word(),
            array(vec![uint(), int(), int(), int(), int()]),
            ParamType::Array(Box::new(uint())),
            bytes(),
            uint(),
        ]),
        array(vec![
            word(),
            uint(),
            ParamType::Bool,
            word(),
            proof_body(),
            word(),
            bytes(),
            bytes(),
            bytes(),
            word(),
        ]),
        array(vec![
            word(),
            uint(),
            word(),
            uint(),
            ParamType::Bool,
            proof_body(),
            bytes(),
        ]),
        ParamType::Array(Box::new(final_dispute())),
        array(vec![
            word(),
            address(),
            uint(),
            ParamType::Uint(8),
            uint(),
            uint(),
        ]),
        array(vec![word(), uint(), uint()]),
        array(vec![address(), word()]),
        array(vec![
            word(),
            ParamType::Bool,
            word(),
            word(),
            ParamType::Tuple(vec![
                ParamType::Uint(16),
                word(),
                ParamType::FixedArray(Box::new(word()), 4),
            ]),
        ]),
    ])
}
