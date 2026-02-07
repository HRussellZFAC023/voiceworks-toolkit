import os
from typing import List

from scraper import Dlsite


class Scanner(object):
    def __init__(self, max_depth=5):
        self.__max_depth = max_depth

    def scan(self, root_paths: List[str], _depth=0):
        """
        Generator. Deeply traverses all folders containing rjcode
        across multiple root paths
        """
        for root_path in root_paths:
            if os.path.isdir(root_path):
                folder = os.path.basename(root_path)
                rjcode = Dlsite.parse_workno(folder)
                if rjcode:
                    yield rjcode, root_path
                elif _depth < self.__max_depth:
                    dir_list = os.listdir(root_path)
                    for folder in dir_list:
                        folder_path = os.path.join(root_path, folder)
                        yield from self.scan([folder_path], _depth + 1)
