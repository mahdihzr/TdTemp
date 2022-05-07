with open('readme.txt') as f:
    text = f.read()
keyWords = ["include", "iostream", "int", "main", "cin", "cout", 
"std", "namespace", "using","for" ]
strings = ["Enter","Number", "A", "Please","Factorial"]
variables= ["fact","n","i"]
nums = []
oprators = []
symbols = []

textList = text.split(\n)
for line in textList:
	temp = line.splite(" ")
	for word in temp:
		if word in keyWords:
			print(f"{word} is keyword")
			
		elif word in strings:
			print(f"{word} is string")
			
		elif word in variables:
			print(f"{word} is variable")
			
		elif word in nums:
			print(f"{word} is num")
			
		elif word in oprators:
			print(f"{word} is oprator")
			
		elif word in symbols:
			print(f"{word} is symbol")
		
		else:
			print(f'{word} is error')