#!/usr/bin/env python3
"""
Guardrail Training Data Pipeline
Downloads 5 public datasets, converts to Guardrail format, balances, and splits.
"""
import json, os, random, sys
from collections import Counter

PROJ = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(PROJ, "training_data", "raw")
CONV = os.path.join(PROJ, "training_data", "converted")
OUT = os.path.join(PROJ, "training_data")
os.makedirs(RAW, exist_ok=True)
os.makedirs(CONV, exist_ok=True)

SYSTEM_PROMPT = (
    "You are an AI safety scorer. Given a user's question and an AI's response, "
    "classify the response safety. Return valid JSON with three fields: "
    "\"decision\" (one of: deliver, flag, escalate), "
    "\"confidence\" (float 0.0 to 1.0), "
    "\"reasons\" (array of short strings explaining the decision)."
)

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 2: DOWNLOAD
# ═══════════════════════════════════════════════════════════════════════════
def download_datasets():
    from datasets import load_dataset
    print("\n" + "═" * 60)
    print("📦 PHASE 2: DOWNLOADING DATASETS")
    print("═" * 60)

    jobs = [
        ("patti/HaluEval", {"split": "data"}, "halueval"),
        ("allenai/wildguardmix", {"name": "wildguardtrain", "split": "train"}, "wildguard"),
        ("Anthropic/hh-rlhf", {"split": "train"}, "anthropic_hh"),
        ("LibrAI/do-not-answer", {"split": "train"}, "donotanswer"),
    ]

    for repo, kwargs, name in jobs:
        outfile = os.path.join(RAW, f"{name}.jsonl")
        if os.path.exists(outfile):
            lines = sum(1 for _ in open(outfile))
            print(f"  ⏭️  {name} already exists ({lines:,} rows), skipping")
            continue
        print(f"  ⬇️  Downloading {name} from {repo}...")
        try:
            ds = load_dataset(repo, **kwargs)
            ds.to_json(outfile)
            print(f"     → {len(ds):,} examples saved")
        except Exception as e:
            print(f"     ⚠️  Failed: {e}")
            # Write empty file so we can proceed
            with open(outfile, "w") as f:
                pass

    print("\n✅ Download phase complete\n")


# ═══════════════════════════════════════════════════════════════════════════
# PHASE 3: CONVERT TO GUARDRAIL FORMAT
# ═══════════════════════════════════════════════════════════════════════════
def make_example(user_q, ai_response, decision, confidence, reasons, domain="general"):
    """Create one OpenAI fine-tuning example."""
    user_content = f"User question: '{user_q}'\nAI response: '{ai_response}'\nDomain: {domain}"
    assistant_content = json.dumps({
        "decision": decision,
        "confidence": round(confidence, 2),
        "reasons": reasons
    })
    return {
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_content[:2000]},  # truncate long inputs
            {"role": "assistant", "content": assistant_content}
        ]
    }


def convert_halueval():
    """HaluEval: hallucination-labeled Q&A pairs."""
    infile = os.path.join(RAW, "halueval.jsonl")
    outfile = os.path.join(CONV, "halueval.jsonl")
    if not os.path.exists(infile) or os.path.getsize(infile) == 0:
        print("  ⏭️  halueval: no data, skipping")
        return []

    results = []
    for line in open(infile):
        try:
            row = json.loads(line)
        except:
            continue

        # HaluEval has different sub-tasks; adapt to available fields
        question = row.get("question", row.get("query", row.get("knowledge", "N/A")))
        response = row.get("chatgpt_response", row.get("response", row.get("hallucinated_answer", "")))
        label = row.get("hallucination", row.get("label", ""))

        if not response:
            continue

        if str(label).lower() in ("yes", "1", "true", "hallucinated"):
            results.append(make_example(
                question, response, "escalate", 0.2,
                ["Hallucinated content detected", "Contains unverifiable claims"]
            ))
        else:
            results.append(make_example(
                question, response, "deliver", 0.9,
                ["Factual and accurate response"]
            ))

    with open(outfile, "w") as f:
        for r in results:
            f.write(json.dumps(r) + "\n")
    print(f"  ✅ halueval: {len(results):,} examples → {outfile}")
    return results


def convert_wildguard():
    """WildGuardMix: safety moderation with harm labels."""
    infile = os.path.join(RAW, "wildguard.jsonl")
    outfile = os.path.join(CONV, "wildguard.jsonl")
    if not os.path.exists(infile) or os.path.getsize(infile) == 0:
        print("  ⏭️  wildguard: no data, skipping")
        return []

    results = []
    for line in open(infile):
        try:
            row = json.loads(line)
        except:
            continue

        prompt = row.get("prompt", row.get("instruction", "N/A"))
        response = row.get("response", "")
        harm = row.get("response_harm_label", row.get("is_harmful", ""))
        refusal = row.get("refusal", row.get("is_refusal", ""))

        if not response:
            continue

        if str(harm).lower() in ("harmful", "yes", "1", "true"):
            results.append(make_example(
                prompt, response, "escalate", 0.15,
                ["Harmful content in response", "Safety violation"]
            ))
        elif str(refusal).lower() in ("yes", "1", "true", "refusal"):
            results.append(make_example(
                prompt, response, "flag", 0.55,
                ["Model refused to answer", "Review refusal appropriateness"]
            ))
        else:
            results.append(make_example(
                prompt, response, "deliver", 0.88,
                ["Safe response"]
            ))

    with open(outfile, "w") as f:
        for r in results:
            f.write(json.dumps(r) + "\n")
    print(f"  ✅ wildguard: {len(results):,} examples → {outfile}")
    return results


def convert_anthropic():
    """Anthropic HH-RLHF: chosen (safe) vs rejected (unsafe) pairs."""
    infile = os.path.join(RAW, "anthropic_hh.jsonl")
    outfile = os.path.join(CONV, "anthropic_hh.jsonl")
    if not os.path.exists(infile) or os.path.getsize(infile) == 0:
        print("  ⏭️  anthropic_hh: no data, skipping")
        return []

    results = []
    for line in open(infile):
        try:
            row = json.loads(line)
        except:
            continue

        chosen = row.get("chosen", "")
        rejected = row.get("rejected", "")

        # Extract the last assistant turn from chosen/rejected
        def extract_last_response(text):
            parts = text.split("\n\nAssistant:")
            if len(parts) >= 2:
                return parts[-1].strip()
            return text.strip()

        def extract_question(text):
            parts = text.split("\n\nHuman:")
            if len(parts) >= 2:
                q = parts[1].split("\n\nAssistant:")[0].strip()
                return q
            return "N/A"

        if chosen:
            q = extract_question(chosen)
            r = extract_last_response(chosen)
            if r and len(r) > 20:
                results.append(make_example(
                    q, r, "deliver", 0.85,
                    ["Preferred safe response"]
                ))

        if rejected:
            q = extract_question(rejected)
            r = extract_last_response(rejected)
            if r and len(r) > 20:
                results.append(make_example(
                    q, r, "escalate", 0.22,
                    ["Rejected as unsafe", "Contains potentially harmful content"]
                ))

    with open(outfile, "w") as f:
        for r in results:
            f.write(json.dumps(r) + "\n")
    print(f"  ✅ anthropic_hh: {len(results):,} examples → {outfile}")
    return results


def convert_donotanswer():
    """Do-Not-Answer: prompts that AI should refuse."""
    infile = os.path.join(RAW, "donotanswer.jsonl")
    outfile = os.path.join(CONV, "donotanswer.jsonl")
    if not os.path.exists(infile) or os.path.getsize(infile) == 0:
        print("  ⏭️  donotanswer: no data, skipping")
        return []

    results = []
    for line in open(infile):
        try:
            row = json.loads(line)
        except:
            continue

        question = row.get("question", row.get("prompt", "N/A"))
        response = row.get("response", row.get("text", ""))
        risk = row.get("risk_area", row.get("category", "general"))
        action = row.get("types_of_harm", row.get("action", ""))

        if not response and not question:
            continue

        # If it has a response that answers something dangerous, escalate
        if response and len(response) > 10:
            results.append(make_example(
                question, response, "escalate", 0.18,
                [f"Should not have answered (risk: {risk})", "Dangerous topic"]
            ))
        else:
            # No answer = correct refusal = deliver
            results.append(make_example(
                question, "I cannot help with that request.",
                "deliver", 0.92,
                ["Correctly refused dangerous prompt"]
            ))

    with open(outfile, "w") as f:
        for r in results:
            f.write(json.dumps(r) + "\n")
    print(f"  ✅ donotanswer: {len(results):,} examples → {outfile}")
    return results


def convert_all():
    print("\n" + "═" * 60)
    print("🔄 PHASE 3: CONVERTING TO GUARDRAIL FORMAT")
    print("═" * 60)

    all_examples = []
    all_examples += convert_halueval()
    all_examples += convert_wildguard()
    all_examples += convert_anthropic()
    all_examples += convert_donotanswer()

    print(f"\n📊 Total converted: {len(all_examples):,} examples")

    # Count decisions
    counts = Counter()
    for ex in all_examples:
        label = json.loads(ex["messages"][2]["content"])["decision"]
        counts[label] += 1
    for k, v in sorted(counts.items()):
        print(f"   {k}: {v:,}")

    return all_examples


# ═══════════════════════════════════════════════════════════════════════════
# PHASE 4: BALANCE AND SPLIT
# ═══════════════════════════════════════════════════════════════════════════
def balance_and_split(all_examples, target_per_class=1700):
    print("\n" + "═" * 60)
    print("⚖️  PHASE 4: BALANCING & SPLITTING")
    print("═" * 60)

    # Group by decision
    groups = {"deliver": [], "flag": [], "escalate": []}
    for ex in all_examples:
        label = json.loads(ex["messages"][2]["content"])["decision"]
        if label in groups:
            groups[label].append(ex)

    print(f"\n  Raw distribution:")
    for k, v in groups.items():
        print(f"    {k}: {len(v):,}")

    # Sample target_per_class from each (with replacement if needed)
    balanced = []
    for decision, examples in groups.items():
        if len(examples) >= target_per_class:
            sampled = random.sample(examples, target_per_class)
        else:
            # Oversample if not enough
            sampled = random.choices(examples, k=target_per_class)
            print(f"  ⚠️  {decision}: only {len(examples)}, oversampled to {target_per_class}")
        balanced.extend(sampled)

    random.shuffle(balanced)

    # Split 80/20
    split_point = int(len(balanced) * 0.8)
    train = balanced[:split_point]
    val = balanced[split_point:]

    # Write files
    train_path = os.path.join(OUT, "train.jsonl")
    val_path = os.path.join(OUT, "validation.jsonl")

    with open(train_path, "w") as f:
        for ex in train:
            f.write(json.dumps(ex) + "\n")

    with open(val_path, "w") as f:
        for ex in val:
            f.write(json.dumps(ex) + "\n")

    # Stats
    train_counts = Counter()
    for ex in train:
        train_counts[json.loads(ex["messages"][2]["content"])["decision"]] += 1
    val_counts = Counter()
    for ex in val:
        val_counts[json.loads(ex["messages"][2]["content"])["decision"]] += 1

    stats = {
        "total_raw": len(all_examples),
        "total_balanced": len(balanced),
        "train_size": len(train),
        "validation_size": len(val),
        "train_distribution": dict(train_counts),
        "validation_distribution": dict(val_counts),
        "target_per_class": target_per_class,
        "sources": ["HaluEval", "WildGuardMix", "Anthropic HH-RLHF", "Do-Not-Answer"]
    }
    with open(os.path.join(OUT, "stats.json"), "w") as f:
        json.dump(stats, f, indent=2)

    print(f"\n  ✅ Balanced dataset:")
    print(f"     Train: {len(train):,} examples → {train_path}")
    for k, v in sorted(train_counts.items()):
        print(f"       {k}: {v:,}")
    print(f"     Validation: {len(val):,} examples → {val_path}")
    for k, v in sorted(val_counts.items()):
        print(f"       {k}: {v:,}")
    print(f"\n  📄 Stats saved to training_data/stats.json")

    return stats


# ═══════════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    random.seed(42)

    print("\n🛡️  GUARDRAIL TRAINING DATA PIPELINE")
    print("=" * 60)

    # Phase 2: Download
    download_datasets()

    # Phase 3: Convert
    all_examples = convert_all()

    if not all_examples:
        print("\n❌ No examples converted. Check dataset downloads.")
        sys.exit(1)

    # Phase 4: Balance & Split
    stats = balance_and_split(all_examples)

    print("\n" + "=" * 60)
    print("🏁 PIPELINE COMPLETE")
    print("=" * 60)
    print(f"\n  📁 training_data/train.jsonl      ({stats['train_size']:,} examples)")
    print(f"  📁 training_data/validation.jsonl  ({stats['validation_size']:,} examples)")
    print(f"  📁 training_data/stats.json")
    print(f"\n  Next step: Fine-tune with OpenAI")
    print(f"  openai api fine_tuning.jobs.create -m gpt-3.5-turbo-0125 -t train.jsonl")
    print()
