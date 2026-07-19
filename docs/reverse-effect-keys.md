# Reverse interaction effect keys

Reverse keys are Active Effect changes owned by the target. They temporarily modify an actor acting toward that target and never write overrides to the acting Actor document.

The namespace wraps the ordinary source-side key:

```text
fallout-maw.reverse.<ordinary-key>
```

For example, this change gives one source of disadvantage to every target-bound attacking action against the effect owner:

```text
key:      fallout-maw.reverse.system.combat.all.disadvantage
type:     add
value:    1
```

## Supported keys

Skill checks:

- `fallout-maw.reverse.system.skills.all.bonus`
- `fallout-maw.reverse.system.skills.all.advantage`
- `fallout-maw.reverse.system.skills.all.disadvantage`
- `fallout-maw.reverse.system.skills.<skill>.bonus`
- `fallout-maw.reverse.system.skills.<skill>.advantage`
- `fallout-maw.reverse.system.skills.<skill>.disadvantage`

Target-bound attacking actions:

- `fallout-maw.reverse.system.combat.all.advantage`
- `fallout-maw.reverse.system.combat.all.disadvantage`
- `fallout-maw.reverse.system.combat.actions.<action>.advantage`
- `fallout-maw.reverse.system.combat.actions.<action>.disadvantage`
- `fallout-maw.reverse.system.combat.accuracy`
- `fallout-maw.reverse.system.combat.criticalChance`
- `fallout-maw.reverse.system.combat.damageFlat`
- `fallout-maw.reverse.system.combat.damagePercent`
- `fallout-maw.reverse.system.combat.burstStability`
- `fallout-maw.reverse.system.combat.finishingBlow`
- `fallout-maw.reverse.system.combat.finishingBlowChance`
- `fallout-maw.reverse.system.penetration.actions.all`
- `fallout-maw.reverse.system.penetration.actions.<action>`

All supported paths are available in the Active Effect and ability/free-settings key autocomplete. Their labels preserve the ordinary key label and append only `(в мою сторону)` in Russian or `(against me)` in English.

## Evaluation rules

- The exact captured target token wins over a world Actor reference, preserving synthetic Actor and ActorDelta effects.
- General and specific keys stack. For example, `skills.all.disadvantage` and `skills.stealth.disadvantage` both contribute to a Stealth check.
- Foundry change modes `add`, `subtract`, `multiply`, `override`, `upgrade`, and `downgrade` are evaluated in priority order.
- Effect formulas are evaluated against the target that owns the reverse effect.
- Disabled, inactive, and system-suppressed trauma/disease effects are ignored.
- Self-targeted interactions do not apply the actor's reverse effects back to itself.
- Conditional ability/free-settings changes receive swapped source/target context, so target faction, race, posture, and weapon conditions describe the actor acting against the owner.

An area volley is rolled against a point, not one Actor, so target-owned advantage, disadvantage, accuracy, and critical-chance changes are not aggregated into that shared roll. Its damage is still resolved per target, including delayed explosions, and therefore uses reverse flat and percentage damage changes. Explosion modifiers are applied to the total damage before pellet distribution, scaled by falloff, and applied before the snapshotted critical multiplier.

Penetration is resolved separately for every affected target. The target-adjusted value is written into that target's damage requests, used for its mitigation, and also controls whether a projectile which penetrated that target may continue along its trajectory. Delayed volley attacks snapshot the weapon formula, weapon data, and ordinary attacker effects when thrown. At detonation, target-dependent source changes replace any targetless branch captured from the same mixed condition, then all source changes are folded once in their shared priority order before the target's current reverse changes are applied.

Burst stability is calculated at each actual target check, so different Actors crossed by one projectile may modify the same burst shot differently. An area volley still has no exact target for its shared point roll and does not aggregate reverse stability.

Action blocks and action/resource costs are intentionally not exposed as reverse keys. Those values are chosen before or across multiple targets and require a deterministic aggregation policy; applying one target's value to the shared action would produce incorrect results for other targets.

Healing already uses ordinary `system.healing.outgoingPercent` on the healer and `system.healing.incomingPercent` on the recipient. Damage mitigation is likewise evaluated on the receiving Actor. Use those ordinary keys/settings rather than creating reverse duplicates.

Prepared characteristic and proficiency bonus paths are also not mirrored. A proficiency `bonus` changes that proficiency's maximum and then clamps its stored value; treating it as a direct per-target value modifier would not match the Actor data model. Use the dedicated reverse accuracy, critical-chance, damage, skill, and penetration keys for interaction-scoped modifiers.

One-use skill modifiers and smart result-fudging keys are not mirrored. Their claim and consumption state belongs to the Actor making the roll; borrowing them from a target without transferring that lifecycle would either consume the wrong effect or leave it reusable indefinitely. Use reverse skill bonus, advantage/disadvantage, accuracy, and critical-chance keys instead.

## Manual verification checklist

1. Attack an unaffected target, then a target with reverse disadvantage `1`.
2. Combine attacker advantage with target reverse disadvantage and verify cancellation by counts.
3. Combine general and action-specific reverse changes.
4. Repeat with a disabled effect and with a suppressed trauma/disease effect.
5. Check a linked Actor token and two unlinked tokens with different effects.
6. Verify damage changes on a direct hit, a multi-pellet hit, an immediate volley at full and partial falloff, a delayed critical volley, and an aimed shot penetrating a held weapon.
7. Verify reverse penetration against the first and second target on one trajectory, an aimed held weapon, an immediate volley, and a delayed volley.
8. Verify that two targets crossed by one burst projectile can apply different reverse burst-stability values.
9. On a delayed volley, combine a low-priority target change with a higher-priority weapon override, then repeat with weapon/target conditions in one OR group.
10. Verify finishing-blow conditions after the attack's last condition or quantity cost breaks/removes the weapon.
11. Repeat a skill check through First Aid, Medicine, Repair, Stealth, Hacking, Grapple, active Push, and a targeted fixed ability.
