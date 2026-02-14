use std::collections::HashMap;

pub fn render_prompt(template: &str, vars: &HashMap<String, String>) -> String {
    let mut result = template.to_string();
    for (key, value) in vars {
        let placeholder = format!("{{{{{}}}}}", key);
        result = result.replace(&placeholder, value);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_render_prompt() {
        let template = "Review PR #{{pr_number}} in {{repo}}\n\n```diff\n{{diff}}\n```";
        let mut vars = HashMap::new();
        vars.insert("pr_number".to_string(), "42".to_string());
        vars.insert("repo".to_string(), "owner/repo".to_string());
        vars.insert("diff".to_string(), "+added line".to_string());

        let rendered = render_prompt(template, &vars);
        assert!(rendered.contains("PR #42"));
        assert!(rendered.contains("owner/repo"));
        assert!(rendered.contains("+added line"));
    }
}
