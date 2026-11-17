mod common;

use common::Fixture;
use kition_env::{GenerateOptions, Oracle, OracleOptions};

#[tokio::test]
async fn projected_edits_generate_complete_tasks_and_reward_one_traces() {
    let f = Fixture::with_env(
        "envprojected",
        "KITION_KIT_MOCK_PROJECTED=1 KITION_KIT_MOCK_BATCH=commands",
        &[("note.envprojected", "#s=Intro\na=Alpha\nb=Beta\n#t=More\nc=Gamma")],
    )
    .expect("build mock");
    for kind in ["set-field", "replace-text", "create", "delete", "move"] {
        let generated = kition_env::generate(
            &f.kit,
            f.workspace.path(),
            &GenerateOptions { count: 4, seed: 21, inverse_share: 0.0, kinds: Some(vec![kind.into()]), ..Default::default() },
        )
        .await
        .unwrap();
        assert!(generated.skipped.is_empty(), "{kind}: {:?}", generated.skipped);
        assert_eq!(generated.tasks.len(), 4, "{kind}: {:?}", generated.given_up);
        for task in generated.tasks {
            assert!(task.ground_truth.to_string().contains("Line") || task.ground_truth.to_string().contains("Section"), "{}", task.ground_truth);
            let mut oracle = Oracle::new(&task, OracleOptions::default());
            let trace = kition_env::trace(&f.kit, f.workspace.path(), &task, &mut oracle).await.unwrap();
            assert_eq!(trace.reward.reward, 1.0, "{kind}: {}", trace.to_line());
        }
    }
}
