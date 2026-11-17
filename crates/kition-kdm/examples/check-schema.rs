//! Checks a kit's KDM schema: `cargo run -p kition-kdm --example check-schema -- model/schema.json`.

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: check-schema <schema.json>");
        std::process::exit(2);
    };
    let outcome =
        std::fs::read_to_string(&path).map_err(|error| error.to_string()).and_then(|json| kition_kdm::Schema::parse(&json).map_err(|error| error.to_string()));
    match outcome {
        Ok(schema) => println!("ok: {} schema {} with {} types", schema.kit, schema.schema_version, schema.types.len()),
        Err(error) => {
            eprintln!("{path}: {error}");
            std::process::exit(1);
        }
    }
}
