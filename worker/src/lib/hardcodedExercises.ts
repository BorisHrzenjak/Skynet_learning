type DifficultyBand = 'basic' | 'intermediate' | 'advanced'

export type HardcodedExercise = {
  id: string
  promptMd: string
  starterCode: string
  referenceSolution: string
  tests: string
  difficultyBand: DifficultyBand
  topics: Array<{
    id: string
    displayName: string
  }>
}

export const HARDCODED_EXERCISES: HardcodedExercise[] = [
  {
    id: 'basic-even-labels',
    promptMd: `# Even labels

Write a function named \`describe_numbers(values)\`.

## What goes in

- \`values\` will be a list of integers.

## What should come out

- Return a **new list of strings**.
- Each string should describe one number.
- For an even number, the string should look like \`"4 is even"\`.
- For an odd number, the string should look like \`"5 is odd"\`.

## Rules

- Keep the numbers in the same order they appear in the input list.
- If the input list is empty, return an empty list.
- Do **not** print anything inside the function.

## Example

\`describe_numbers([1, 2, 5])\` should return:

\`["1 is odd", "2 is even", "5 is odd"]\`

Return the list instead of printing it.`,
    starterCode: `def describe_numbers(values):
    # return a list like ["1 is odd", "2 is even"]
    pass
`,
    referenceSolution: `def describe_numbers(values):
    result = []
    for value in values:
        label = "even" if value % 2 == 0 else "odd"
        result.append(f"{value} is {label}")
    return result
`,
    tests: `from solution import describe_numbers


def test_empty_list():
    assert describe_numbers([]) == []


def test_mixed_values():
    assert describe_numbers([1, 2, 5]) == [
        "1 is odd",
        "2 is even",
        "5 is odd",
    ]
`,
    difficultyBand: 'basic',
    topics: [
      { id: 'loops', displayName: 'Loops' },
      { id: 'formatting_fstrings', displayName: 'Formatting and f-strings' },
    ],
  },
  {
    id: 'basic-word-counts',
    promptMd: `# Word counts

Write a function named \`count_words(words)\`.

## What goes in

- \`words\` will be a list of lowercase strings.

## What should come out

- Return a dictionary.
- Each key should be a word from the input list.
- Each value should be how many times that word appears.

## Rules

- If a word appears more than once, increase its count.
- If the input list is empty, return an empty dictionary.
- You do not need to sort anything.

## Example

\`count_words(["red", "blue", "red"])\` should return \`{"red": 2, "blue": 1}\`.`,
    starterCode: `def count_words(words):
    counts = {}
    return counts
`,
    referenceSolution: `def count_words(words):
    counts = {}
    for word in words:
        counts[word] = counts.get(word, 0) + 1
    return counts
`,
    tests: `from solution import count_words


def test_empty_input():
    assert count_words([]) == {}


def test_repeated_words():
    assert count_words(["red", "blue", "red", "red"]) == {
        "red": 3,
        "blue": 1,
    }
`,
    difficultyBand: 'basic',
    topics: [
      { id: 'dicts', displayName: 'Dicts' },
      { id: 'functions_basic', displayName: 'Functions' },
    ],
  },
  {
    id: 'basic-fizzbuzz-lite',
    promptMd: `# FizzBuzz lite

Write a function named \`fizzbuzz_values(limit)\`.

## What goes in

- \`limit\` will be a positive integer.

## What should come out

- Return a list of values from **1 through \`limit\`**.

## Rules

- If a number is divisible by 3, use \`"Fizz"\` instead of the number.
- If a number is divisible by 5, use \`"Buzz"\` instead of the number.
- If a number is divisible by **both** 3 and 5, use \`"FizzBuzz"\`.
- Otherwise, keep the number itself.

## Important detail

- Check the **both 3 and 5** case before the separate 3-only or 5-only cases.

## Example

\`fizzbuzz_values(5)\` should return:

\`[1, 2, "Fizz", 4, "Buzz"]\`
`,
    starterCode: `def fizzbuzz_values(limit):
    result = []
    return result
`,
    referenceSolution: `def fizzbuzz_values(limit):
    result = []
    for value in range(1, limit + 1):
        if value % 15 == 0:
            result.append("FizzBuzz")
        elif value % 3 == 0:
            result.append("Fizz")
        elif value % 5 == 0:
            result.append("Buzz")
        else:
            result.append(value)
    return result
`,
    tests: `from solution import fizzbuzz_values


def test_small_limit():
    assert fizzbuzz_values(5) == [1, 2, "Fizz", 4, "Buzz"]


def test_fifteen():
    assert fizzbuzz_values(15)[-1] == "FizzBuzz"
`,
    difficultyBand: 'basic',
    topics: [
      { id: 'loops', displayName: 'Loops' },
      { id: 'booleans_and_conditionals', displayName: 'Booleans and Conditionals' },
    ],
  },
]
